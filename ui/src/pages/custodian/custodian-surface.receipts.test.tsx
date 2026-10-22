/* @vitest-environment jsdom */

import type { SystemAgentChatParams } from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import type { CustodianAlert } from "../../components/custodian-alert-contract.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { custodianAlertStore } from "./custodian-alert-store.ts";
import type { SetupAutoResult } from "./custodian-auto-setup.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import { CustodianSurface, type CustodianSurfaceProps } from "./custodian-surface.tsx";

describe("automatic setup", () => {
  type Page = Awaited<ReturnType<typeof mountPage>>["page"];
  function candidate(kind: string, label: string, modelRef: string) {
    return { kind, label, modelRef, detail: "Available" };
  }
  const selected = candidate("codex", "ChatGPT", "openai/gpt-5.5");
  const alternative = candidate("ollama", "Local model", "ollama/qwen3");
  function result(): SetupAutoResult {
    return {
      status: "activated",
      selected,
      alternatives: [alternative],
      attempts: [],
      installedPlugins: [],
    };
  }
  const methods = ["chat", "setup.auto", "setup.activate", "setup.auth.start"].map(
    (method) => "openclaw." + method,
  );
  const agentsList: AgentsListResult = {
    defaultId: "main",
    mainKey: "main",
    scope: "global",
    agents: [{ id: "main" }],
  };
  const reply = { sessionId: "setup-session", reply: "Welcome.", action: "none" };
  type Request = Parameters<typeof createContext>[0];
  const text = (page: Page) => expect(page.textContent);
  const alertText = (page: Page) => expect(page.querySelector('[role="alert"]')?.textContent);
  function setupRequest(auto: () => unknown = () => result()) {
    return vi.fn(async (method: string) => (method === "openclaw.setup.auto" ? auto() : reply));
  }
  const setupContext = (request: Request) => createContext(request, methods, { agentsList });
  async function mountSetup(request: Request) {
    const harness = setupContext(request);
    const mounted = await mountPage(harness.context);
    await settled(mounted.page);
    return { ...harness, ...mounted };
  }
  async function settled(page: Page, expected = () => true) {
    await new Promise<void>((resolve) => {
      const whenReady = () => {
        const setup = page.store.autoSetup;
        if (expected() && !setup.pending && !page.store.sending) {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = page.store.subscribe(whenReady);
      whenReady();
    });
    flush();
    await page.updateComplete;
  }
  async function click(page: Page, label: string) {
    const buttons = [...page.querySelectorAll("button")];
    const button = buttons.find((entry) => entry.textContent?.trim() === label);
    expect(button).toBeDefined();
    button!.click();
    await settled(page);
  }

  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(() => {
    localStorage.clear();
    delete window["__OPENCLAW_NATIVE_SETUP__"];
    vi.unstubAllGlobals();
  });

  it("follows a replacement store without accepting the old store's dismissal", async () => {
    let autoCalls = 0;
    const request = setupRequest(() => ({
      ...result(),
      selected: autoCalls++ === 0 ? selected : alternative,
    }));
    const { page } = await mountSetup(request);
    const previous = page.store;
    page.store = new CustodianSessionStore();
    await settled(page, () => page.store.autoSetup.ready);
    text(page).toContain("Using Local model (ollama/qwen3)");
    previous.autoSetup.dismiss();
    flush();
    await page.updateComplete;
    expect(page.querySelector(".custodian-setup")).not.toBeNull();
    text(page).toContain("Using Local model (ollama/qwen3)");
    text(page).not.toContain("Using ChatGPT");
  });

  it("updates native recovery when its capability snapshot arrives", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    const post = vi.fn().mockResolvedValue(snapshot);
    vi.stubGlobal("webkit", {
      messageHandlers: { openclawDeviceSettings: { postMessage: post } },
    });
    vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
    const nativeDeviceSettings = createNativeDeviceSettingsCapability()!;
    const request = vi.fn(async (): Promise<SetupAutoResult> => ({
      status: "unavailable",
      alternatives: [],
      attempts: [],
      installedPlugins: [],
    }));
    const { context } = setupContext(request);
    try {
      const { page } = await mountPage({ ...context, nativeDeviceSettings });
      await settled(page);
      text(page).toContain("openclaw onboard");
      text(page).toContain("only connect tools you trust");
      expect(request).toHaveBeenCalledTimes(1);
      window.dispatchEvent(
        new CustomEvent("openclaw:native-device-settings-changed", {
          detail: {
            ...snapshot,
            capabilities: { ...snapshot.capabilities, aiSetupAvailable: true },
          },
        }),
      );
      await settled(page);
      await click(page, "Open AI setup");
      expect(post).toHaveBeenCalledWith({ type: "open", panel: "ai-setup" });
      text(page).not.toContain("openclaw onboard");
    } finally {
      nativeDeviceSettings.dispose();
    }
  });

  it("shows RPC failures and retries without a premature greeting", async () => {
    const request = setupRequest(() => {
      throw new Error("Gateway lost its connection");
    });
    const { page } = await mountSetup(request);
    alertText(page).toContain("Gateway lost its connection");
    expect(request).toHaveBeenCalledWith("openclaw.setup.auto", {}, { timeoutMs: null });
    expect(request).toHaveBeenCalledTimes(1);
    await click(page, "Retry");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("ignores an old Gateway result after connection ownership changes", async () => {
    const pending = createDeferred<SetupAutoResult>();
    const request = vi.fn(async () => pending.promise);
    const { context, setGatewaySnapshot } = setupContext(request);
    const { page } = await mountPage(context);
    const replacement = setupRequest(() => ({ ...result(), selected: alternative }));
    setGatewaySnapshot({
      client: { request: replacement } as unknown as GatewayBrowserClient,
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "synthetic-new-owner",
        },
        features: { methods },
      },
    });
    await settled(page);
    pending.resolve(result());
    await pending.promise;
    await settled(page);
    text(page).toContain("Using Local model");
    text(page).not.toContain("Using ChatGPT");
  });

  it("preserves the existing caretaker flow without the advertised method", async () => {
    const request = vi.fn(async () => reply);
    const { context } = createContext(request, ["openclaw.chat"], { agentsList });
    const { page } = await mountPage(context, { onboarding: false });
    await settled(page);
    expect(page.querySelector(".custodian-setup")).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(page.querySelector(".custodian__setup-state")).not.toBeNull();
  });
});

type Inputs = Pick<CustodianSurfaceProps, "store" | "onboarding" | "newAgentIntent">;

function session(reply: string) {
  const response = { sessionId: "custodian-session", reply, action: "none" };
  const request = vi.fn(async (_method: string, _params: SystemAgentChatParams) => response);
  return {
    request,
    context: createContext(request).context,
    store: new CustodianSessionStore(),
    welcomes: () => request.mock.calls.map(([, params]) => params.welcomeVariant),
  };
}

function mountSurface(reply: string, onboarding = false) {
  const fixture = session(reply);
  const { context, store } = fixture;
  const provider = createApplicationContextProvider(context);
  const surface = document.createElement("openclaw-custodian-surface");
  Object.assign(surface, { store, onboarding, newAgentIntent: false });
  provider.append(surface);
  document.body.append(provider);
  return { ...fixture, provider, surface };
}

function ready(store: CustodianSessionStore, activeVariant: string) {
  return waitForSolid(() => expect(store).toMatchObject({ activeVariant, canSend: true }));
}

afterEach(() => {
  custodianAlertStore.dismiss();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("connects native initial properties and coalesces route intent changes", async () => {
  const { store, welcomes, surface } = mountSurface("Native session ready.", true);
  await waitForSolid(() => expect(store.canSend).toBe(true));
  expect(welcomes()).toEqual(["onboarding"]);

  const variants = new Set<string>();
  const stop = store.subscribe(() => variants.add(store.activeVariant));
  surface.onboarding = false;
  surface.newAgentIntent = true;
  await ready(store, "new-agent");
  stop();
  expect(variants).toEqual(new Set(["new-agent"]));
  expect(welcomes()).toEqual(["onboarding", "new-agent"]);
  expect(surface.textContent).toContain("Native session ready.");
});

it("follows Solid prop and store replacements without retaining the previous draft", async () => {
  const { request, context, store: first, welcomes } = session("Solid session ready.");
  let updateInputs!: (inputs: Inputs) => void;
  const initial: Inputs = { store: first, onboarding: true, newAgentIntent: false };
  const { container } = mountSolid(() => {
    const [inputs, setInputs] = createSignal(initial);
    updateInputs = setInputs;
    return (
      <ApplicationProvider value={context}>
        <CustodianSurface {...inputs()} />
      </ApplicationProvider>
    );
  });
  await waitForSolid(() => expect(first.canSend).toBe(true));

  const replacement = new CustodianSessionStore();
  const next = { store: replacement, onboarding: false, newAgentIntent: true };
  updateInputs(next);
  await ready(replacement, "new-agent");
  first.setInput("Old draft");
  replacement.setInput("New draft");
  await waitForSolid(() => expect(container.querySelector("textarea")?.value).toBe("New draft"));
  updateInputs({ ...next });
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  expect(welcomes()).toEqual(["onboarding", "new-agent"]);
  expect(first.activeVariant).toBe("onboarding");
  expect(container.textContent).toContain("Solid session ready.");
});

it("rebinds native context, preserves reparenting, and retires detached input receipts", async () => {
  const { request: firstRequest, store, provider, surface } = mountSurface("First Gateway ready.");
  const { request: secondRequest, context: secondContext } = session("Second Gateway ready.");
  await waitForSolid(() => expect(store.canSend).toBe(true));
  provider.setContext(secondContext);
  await waitForSolid(() => expect(store.activeClient).toBe(secondContext.gateway.snapshot.client));
  await store.send("Use the replacement Gateway");
  expect(firstRequest).toHaveBeenCalledTimes(1);
  expect(secondRequest).toHaveBeenLastCalledWith(
    "openclaw.chat",
    expect.objectContaining({ message: "Use the replacement Gateway" }),
    expect.any(Object),
  );

  surface.newAgentIntent = true;
  await ready(store, "new-agent");
  expect(secondRequest.mock.calls.at(-1)?.[1].welcomeVariant).toBe("new-agent");
  store.setInput("Keep the reparented draft");
  surface.remove();
  provider.append(surface);
  await waitForSolid(() =>
    expect(surface.querySelector("textarea")?.value).toBe("Keep the reparented draft"),
  );

  surface.remove();
  await Promise.resolve();
  const detached = new CustodianSessionStore();
  Object.assign(surface, { store: detached, onboarding: true, newAgentIntent: false });
  await surface.updateComplete;
  expect(detached.activeClient).toBeNull();
  expect(secondRequest).toHaveBeenCalledTimes(2);
  provider.append(surface);
  await ready(detached, "onboarding");
  expect(secondRequest).toHaveBeenCalledTimes(3);
  expect(surface.textContent).toContain("Second Gateway ready.");
});

describe("custodian alerts", () => {
  const incident: CustodianAlert = {
    id: "recurring-incident",
    title: "1 automation failed",
    facts: ["Nightly backup: disk full"],
    question: "Why did Nightly backup fail?",
  };

  it("asks once per presentation and re-arms the same incident", () => {
    const send = vi.fn();
    const listener = vi.fn();
    const unsubscribe = custodianAlertStore.subscribe(listener);
    custodianAlertStore.present(incident);
    expect(custodianAlertStore.alert).toBe(incident);
    expect(listener).toHaveBeenCalledOnce();
    custodianAlertStore.askIfReady(send);
    custodianAlertStore.askIfReady(send);
    expect(send).toHaveBeenCalledExactlyOnceWith(incident.question);
    custodianAlertStore.dismiss();
    expect(custodianAlertStore.alert).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    custodianAlertStore.present(incident);
    custodianAlertStore.askIfReady(send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retires scoped facts and a queued question when its owner loses authority", () => {
    let current = true;
    const admit = vi.fn(() => true);
    const send = vi.fn();
    custodianAlertStore.present(incident, { isCurrent: () => current, admit });
    current = false;

    custodianAlertStore.askIfReady(send);

    expect(custodianAlertStore.alert).toBeNull();
    expect(admit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("renders without sending when custodian chat is unavailable", async () => {
    const { context } = createContext(vi.fn(), []);
    const provider = createApplicationContextProvider(context);
    const sessionStore = new CustodianSessionStore();
    const send = vi.spyOn(sessionStore, "send");
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = sessionStore;
    provider.append(surface);
    document.body.append(provider);

    custodianAlertStore.present(incident);
    await surface.updateComplete;

    expect(send).not.toHaveBeenCalled();
    expect(surface.querySelector(".custodian__alert-card")?.textContent).toContain(
      "Nightly backup: disk full",
    );
  });
});
