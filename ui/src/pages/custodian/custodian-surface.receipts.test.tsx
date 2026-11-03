/* @vitest-environment jsdom */

import type { SystemAgentChatParams } from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import { CustodianSurface, type CustodianSurfaceProps } from "./custodian-surface.tsx";

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
