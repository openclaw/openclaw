/* @vitest-environment jsdom */

import type { SystemAgentChatParams } from "@openclaw/gateway-protocol";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import { CustodianSurface, type CustodianSurfaceProps } from "./custodian-surface.tsx";

type Inputs = Pick<CustodianSurfaceProps, "store" | "onboarding" | "newAgentIntent">;

function chatRequest(reply: string) {
  return vi.fn(async (_method: string, _params: SystemAgentChatParams) => ({
    sessionId: "custodian-session",
    reply,
    action: "none",
  }));
}

function mountSurface(context: ApplicationContext, inputs: Inputs) {
  const provider = createApplicationContextProvider(context);
  const surface = document.createElement("openclaw-custodian-surface");
  Object.assign(surface, inputs);
  provider.append(surface);
  document.body.append(provider);
  return { provider, surface };
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("custodian surface input receipts", () => {
  it("connects native initial properties and coalesces route intent changes", async () => {
    const request = chatRequest("Native session ready.");
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    const { surface } = mountSurface(context, {
      store,
      onboarding: true,
      newAgentIntent: false,
    });
    await waitForSolid(() => expect(store.canSend).toBe(true));
    expect(request.mock.calls.map(([, params]) => params.welcomeVariant)).toEqual(["onboarding"]);

    const variants = new Set<string>();
    const stop = store.subscribe(() => variants.add(store.activeVariant));
    surface.onboarding = false;
    surface.newAgentIntent = true;
    await waitForSolid(() => {
      expect(store.activeVariant).toBe("new-agent");
      expect(store.canSend).toBe(true);
    });
    stop();
    expect(variants).toEqual(new Set(["new-agent"]));
    expect(request.mock.calls.map(([, params]) => params.welcomeVariant)).toEqual([
      "onboarding",
      "new-agent",
    ]);
    expect(surface.textContent).toContain("Native session ready.");
  });

  it("follows Solid prop and store replacements without retaining the previous draft", async () => {
    const request = chatRequest("Solid session ready.");
    const { context } = createContext(request);
    const first = new CustodianSessionStore();
    let updateInputs!: (inputs: Inputs) => void;
    const view = mountSolid(() => {
      const [inputs, setInputs] = createSignal<Inputs>({
        store: first,
        onboarding: true,
        newAgentIntent: false,
      });
      updateInputs = setInputs;
      return (
        <ApplicationProvider value={context}>
          <CustodianSurface
            store={inputs().store}
            onboarding={inputs().onboarding}
            newAgentIntent={inputs().newAgentIntent}
          />
        </ApplicationProvider>
      );
    });
    await waitForSolid(() => expect(first.canSend).toBe(true));

    const replacement = new CustodianSessionStore();
    const next = { store: replacement, onboarding: false, newAgentIntent: true };
    updateInputs(next);
    await waitForSolid(() => {
      expect(replacement.activeVariant).toBe("new-agent");
      expect(replacement.canSend).toBe(true);
    });
    first.setInput("Previous owner draft");
    replacement.setInput("Replacement owner draft");
    await waitForSolid(() =>
      expect(view.container.querySelector("textarea")?.value).toBe("Replacement owner draft"),
    );
    updateInputs({ ...next });
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([, params]) => params.welcomeVariant)).toEqual([
      "onboarding",
      "new-agent",
    ]);
    expect(first.activeVariant).toBe("onboarding");
    expect(view.container.textContent).toContain("Solid session ready.");
  });

  it("rebinds native context, preserves reparenting, and retires detached input receipts", async () => {
    const firstRequest = chatRequest("First Gateway ready.");
    const secondRequest = chatRequest("Second Gateway ready.");
    const firstContext = createContext(firstRequest).context;
    const secondContext = createContext(secondRequest).context;
    const store = new CustodianSessionStore();
    const { provider, surface } = mountSurface(firstContext, {
      store,
      onboarding: false,
      newAgentIntent: false,
    });
    await waitForSolid(() => expect(store.canSend).toBe(true));
    provider.setContext(secondContext);
    await waitForSolid(() =>
      expect(store.activeClient).toBe(secondContext.gateway.snapshot.client),
    );
    await store.send("Use the replacement Gateway");
    expect(firstRequest).toHaveBeenCalledTimes(1);
    expect(secondRequest).toHaveBeenLastCalledWith(
      "openclaw.chat",
      expect.objectContaining({ message: "Use the replacement Gateway" }),
      expect.any(Object),
    );

    surface.newAgentIntent = true;
    await waitForSolid(() => {
      expect(store.activeVariant).toBe("new-agent");
      expect(store.canSend).toBe(true);
    });
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
    surface.store = detached;
    surface.onboarding = true;
    surface.newAgentIntent = false;
    await surface.updateComplete;
    expect(detached.activeClient).toBeNull();
    expect(secondRequest).toHaveBeenCalledTimes(2);
    provider.append(surface);
    await waitForSolid(() => {
      expect(detached.activeVariant).toBe("onboarding");
      expect(detached.canSend).toBe(true);
    });
    expect(secondRequest).toHaveBeenCalledTimes(3);
    expect(surface.textContent).toContain("Second Gateway ready.");
  });
});
