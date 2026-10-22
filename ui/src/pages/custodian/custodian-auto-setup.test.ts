/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { SetupAutoResult } from "./custodian-auto-setup.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";

function candidate(kind: string, label: string, modelRef: string) {
  return { kind, label, modelRef, detail: "Available" };
}
const selected = candidate("codex", "ChatGPT", "openai/gpt-5.5");
const alternative = candidate("ollama", "Local model", "ollama/qwen3");
function result(status: SetupAutoResult["status"] = "activated"): SetupAutoResult {
  return { status, selected, alternatives: [alternative], attempts: [], installedPlugins: [] };
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
type Page = Awaited<ReturnType<typeof mountPage>>["page"];
type Request = Parameters<typeof createContext>[0];
const text = (page: Page) => expect(page.textContent);
const alertText = (page: Page) => expect(page.querySelector('[role="alert"]')?.textContent);
const expectRpc = (request: Request, method: string, params: unknown) =>
  expect(request).toHaveBeenCalledWith("openclaw.setup." + method, params, { timeoutMs: null });
function setupRequest(
  auto: () => unknown = () => result(),
  handlers: Record<string, (params?: { answer?: unknown }) => unknown> = {},
) {
  return vi.fn(async (method: string, params?: { answer?: unknown }) =>
    method === "openclaw.chat.history"
      ? (handlers[method]?.(params) ?? { turns: [] })
      : method === "openclaw.setup.auto"
        ? auto()
        : (handlers[method]?.(params) ?? reply),
  );
}
function unavailable(attempts: SetupAutoResult["attempts"] = []): SetupAutoResult {
  return { status: "unavailable", alternatives: [], attempts, installedPlugins: [] };
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
    const ready = () => {
      const setup = page.store.autoSetup;
      if (
        expected() &&
        !setup.pending &&
        !page.store.sending &&
        setup.wizard.state.phase !== "starting" &&
        !(setup.wizard.state.phase === "step" && setup.wizard.state.busy)
      ) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = page.store.subscribe(ready);
    ready();
  });
  flush();
  await page.updateComplete;
}
async function click(page: Page, label: string, expected?: () => boolean) {
  const buttons = [...page.querySelectorAll("button")];
  const button = buttons.find((entry) => entry.textContent?.trim() === label);
  expect(button).toBeDefined();
  button!.click();
  await settled(page, expected);
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  delete window["__OPENCLAW_NATIVE_SETUP__"];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])("activates alternatives only on success (%s)", async (ok) => {
  const setup = createDeferred<SetupAutoResult>();
  const request = setupRequest(() => setup.promise, {
    "openclaw.setup.activate": () =>
      ok ? { ok, modelRef: alternative.modelRef } : { ok, error: "Local model is offline" },
  });
  const { context } = setupContext(request);
  const { page } = await mountPage(context);
  text(page).toContain("Connecting your AI");
  expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.setup.auto"]);
  expectRpc(request, "auto", {});
  setup.resolve(result(ok ? "configured" : "activated"));
  await settled(page);
  text(page).toContain("Using ChatGPT (openai/gpt-5.5) on gateway.test");
  text(page).toContain(reply.reply);
  await click(page, "Local model");
  expectRpc(request, "activate", { kind: "ollama" });
  text(page).toContain(ok ? "Using Local model (ollama/qwen3) on gateway.test" : "Using ChatGPT");
  if (!ok) {
    alertText(page).toContain("Local model is offline");
  }
  expect(request.mock.calls.filter(([method]) => method === "openclaw.setup.auto")).toHaveLength(1);
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

it.each(["needs-sign-in", "configured"] as const)("refreshes sign-in from %s", async (status) => {
  let autoCalls = 0;
  const shared = status === "configured";
  const authChoice = shared ? "codex-separate-sign-in" : "codex-sign-in";
  const signIn = { authOptionId: authChoice, label: "ChatGPT" };
  const initial = shared
    ? { ...result(status), selected: { ...selected, shared: true }, separateSignIn: signIn }
    : { ...unavailable(), status, installedPlugins: ["codex"], signIn };
  const request = setupRequest(() => (autoCalls++ ? result() : initial), {
    "openclaw.setup.auth.start": () => ({ sessionId: "auth-session", done: false }),
    "wizard.next": (params) =>
      params?.answer
        ? { done: true, status: "done" }
        : {
            done: false,
            step: { id: "confirm", type: "confirm", message: "Finish signing in?" },
          },
  });
  const { page } = await mountSetup(request);
  const setup = page.store.autoSetup;
  if (!shared) {
    expect(request.mock.calls.filter(([method]) => method === "openclaw.chat")).toHaveLength(0);
  } else {
    text(page).toContain("Using your existing Codex login · sessions shared with Codex");
  }
  await click(page, shared ? "Use a separate login" : "Sign in with ChatGPT");
  expectRpc(request, "auth.start", expect.objectContaining({ authChoice }));
  text(page).toContain("Finish signing in?");
  await click(page, "Yes", () => autoCalls === 2 && setup.ready && !setup.result?.selected?.shared);
  expect(autoCalls).toBe(2);
  text(page).toContain("Using ChatGPT");
  text(page).toContain(reply.reply);
  text(page).not.toContain("sessions shared with Codex");
  text(page).not.toContain("Use a separate login");
});

it("uses shell-neutral native capabilities for fallback, Gateway selection, and permissions", async () => {
  const openAiSetup = vi.fn();
  const openGateways = vi.fn();
  const reviewPermissions = vi.fn();
  window["__OPENCLAW_NATIVE_SETUP__"] = { openAiSetup, openGateways, reviewPermissions };
  const request = vi.fn(async () => unavailable());
  const { page } = await mountSetup(request);
  await click(page, "Open AI setup");
  await click(page, "Use a different Gateway");
  await click(page, "Review permissions");
  expect(openAiSetup).toHaveBeenCalledOnce();
  expect(openGateways).toHaveBeenCalledOnce();
  expect(reviewPermissions).toHaveBeenCalledOnce();
  text(page).not.toContain("openclaw onboard");
});

it.each([false, true])(
  "updates native recovery when its capability snapshot arrives (failed attempt: %s)",
  async (failedAttempt) => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    const post = vi.fn().mockResolvedValue(snapshot);
    vi.stubGlobal("webkit", { messageHandlers: { openclawDeviceSettings: { postMessage: post } } });
    vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
    const nativeDeviceSettings = createNativeDeviceSettingsCapability()!;
    const request = vi.fn(async () =>
      unavailable(
        failedAttempt
          ? [{ kind: "codex", label: "ChatGPT", error: "Could not prepare the plugin" }]
          : [],
      ),
    );
    const { context } = setupContext(request);
    try {
      const { page } = await mountPage({ ...context, nativeDeviceSettings });
      await settled(page);
      text(page).toContain("openclaw onboard");
      if (failedAttempt) {
        text(page).toContain("Could not prepare the plugin");
      }
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
  },
);

it("shows RPC failures and retries without a premature greeting", async () => {
  const request = setupRequest(() => {
    throw new Error("Gateway lost its connection");
  });
  const { page } = await mountSetup(request);
  alertText(page).toContain("Gateway lost its connection");
  expect(request).toHaveBeenCalledTimes(1);
  await click(page, "Retry");
  expect(request).toHaveBeenCalledTimes(2);
});

it("persists dismissal across a new custodian store", async () => {
  const request = setupRequest();
  const { context } = setupContext(request);
  const first = await mountPage(context);
  await settled(first.page);
  first.page.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click();
  await settled(first.page);
  expect(first.page.querySelector(".custodian-setup")).toBeNull();
  first.provider.remove();
  const second = await mountPage(context);
  await settled(second.page);
  expect(second.page.querySelector(".custodian-setup")).toBeNull();
  expect(second.page.textContent).toContain(reply.reply);
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
      auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "synthetic-new-owner" },
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
