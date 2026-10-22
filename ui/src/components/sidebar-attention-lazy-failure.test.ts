/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import { createSidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { showToast } from "../lib/toast.ts";
import {
  createApplicationContextProvider,
  hiddenScopeUpgradeCapability,
} from "../test-helpers/application-context.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";
import "./sidebar-attention.tsx";

const { loadFailure } = vi.hoisted(() => ({
  loadFailure: vi.fn<() => Promise<never> | undefined>(),
}));
// mock-isolation: Observe feedback without creating document-global toast hosts.
vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../lib/idle-import.ts", async (original) => {
  const actual = await original<typeof import("../lib/idle-import.ts")>();
  return {
    ...actual,
    createIdleImport: (...args: Parameters<typeof actual.createIdleImport>) => {
      const loader = actual.createIdleImport(...args);
      return { ...loader, load: () => loadFailure() ?? loader.load() };
    },
  };
});
const stores = new Set<ReturnType<typeof createSidebarAttentionStore>>();
afterEach(() => {
  document.body.replaceChildren();
  for (const store of stores) {
    store.dispose();
  }
  stores.clear();
  loadFailure.mockReset();
  vi.mocked(showToast).mockClear();
});

async function mountAttention() {
  const sources = {
    gateway: {
      snapshot: { phase: "connected", client: null, hello: null },
      connection: { gatewayUrl: "" },
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    },
    overlays: { snapshot: { approvalQueue: [] }, subscribe: () => () => {} },
    agentSelection: { state: { selectedId: null, scopeId: null }, subscribe: () => () => {} },
    scopeUpgrade: hiddenScopeUpgradeCapability,
    agents: { state: { agentsList: null }, subscribe: () => () => {} },
  };
  // SAFETY: The fixture supplies exactly the owners observed by Inbox.
  const store = createSidebarAttentionStore(
    sources as unknown as Parameters<typeof createSidebarAttentionStore>[0],
  );
  store.activate(SidebarAttentionStoreOwner);
  stores.add(store);
  // SAFETY: The context fixture fills unrelated application capabilities.
  const provider = createApplicationContextProvider({
    ...sources,
    sidebarAttention: store,
  } as unknown as ApplicationContext);
  const element = document.createElement("openclaw-sidebar-attention");
  provider.append(element);
  document.body.append(provider);
  await waitForSolid(() => expect(element.querySelector("button")).not.toBeNull());
  return { element, trigger: element.querySelector<HTMLButtonElement>(".sidebar-issues-button")! };
}

it("reports a rejected Inbox import and lets the same trigger retry", async () => {
  const failure = new Error("Inbox module unavailable. Try again.");
  loadFailure.mockImplementation(() => Promise.reject(failure));
  const { element, trigger } = await mountAttention();
  trigger.click();
  await waitForSolid(() =>
    expect(showToast).toHaveBeenCalledWith({
      message:
        "Panel failed to load. Some interface files could not be downloaded. Check your connection, then reload.",
      severity: "error",
    }),
  );
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(element.querySelector(".sidebar-issues-panel")).toBeNull();
  loadFailure.mockReset();
  trigger.click();
  await waitForSolid(() => expect(element.querySelector(".sidebar-issues-panel")).not.toBeNull());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

it("retires an Inbox import failure when its route changes", async () => {
  const pending = createDeferred<never>();
  loadFailure.mockReturnValue(pending.promise);
  const { element, trigger } = await mountAttention();
  trigger.click();
  Object.assign(element, { activeRouteId: "config" });
  pending.reject(new Error("Retired Inbox import"));
  await pending.promise.catch(() => undefined);
  await waitForSolid(() => expect(showToast).not.toHaveBeenCalled());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
