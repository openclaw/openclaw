import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { flush } from "solid-js";
import { afterEach, beforeEach, onTestFinished, vi } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { storeSidebarSessionOwnerFilter } from "../components/app-sidebar-session-types.ts";
import type { AppSidebarElement } from "../components/app-sidebar.tsx";
import { disposeSidebarContextLifecycles } from "./app-sidebar-context-lifecycle.ts";
import { createStorageMock } from "./storage.ts";

export function setupSidebarTest() {
  let layoutGlobals: Array<[string, PropertyDescriptor | undefined]>;
  let frameChannel: MessageChannel | undefined;
  const defineGlobal = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

  beforeEach(() => {
    layoutGlobals = [
      "matchMedia",
      "ResizeObserver",
      "IntersectionObserver",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "localStorage",
    ].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    // Settle jsdom frames in microtasks; yield recursive overlay frames to avoid starvation.
    if (!("__vitest_browser__" in globalThis)) {
      // Keep our frame scheduler; jsdom may retire a native timer after fake-clock installation.
      vi.setConfig({
        fakeTimers: {
          shouldClearNativeTimers: true,
          toFake: [
            "setTimeout",
            "clearTimeout",
            "setInterval",
            "clearInterval",
            "Date",
            "performance",
          ],
        },
      });
      let nextFrame = 0;
      let inFrame = false;
      const frames = new Map<number, FrameRequestCallback>();
      const channel = new MessageChannel();
      frameChannel = channel;
      const runFrame = (id: number) => {
        const callback = frames.get(id);
        if (callback) {
          frames.delete(id);
          inFrame = true;
          try {
            callback(performance.now());
          } finally {
            inFrame = false;
          }
        }
      };
      channel.port1.addEventListener("message", (event: MessageEvent<number>) =>
        runFrame(event.data),
      );
      channel.port1.start();
      defineGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        const id = ++nextFrame;
        frames.set(id, callback);
        if (inFrame) {
          channel.port2.postMessage(id);
        } else {
          queueMicrotask(() => runFrame(id));
        }
        return id;
      });
      defineGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    }
    for (const name of ["ResizeObserver", "IntersectionObserver"] as const) {
      if (globalThis[name] === undefined) {
        defineGlobal(
          name,
          class {
            observe() {}
            unobserve() {}
            disconnect() {}
          },
        );
      }
    }

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
    // Most cases assert expanded contents; collapse tests override this preference.
    localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", JSON.stringify([]));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetConfig();
    const sidebars = document.body.querySelectorAll<AppSidebarElement>("openclaw-app-sidebar");
    // Dismiss upgraded menus before settling imports; lazy shells may retain an unupgraded tag.
    for (const sidebar of sidebars) {
      if (sidebar.matches(":defined")) {
        sidebar.dismissTransientMenus();
      }
    }
    await vi.dynamicImportSettled();
    // Removing a prompt's DOM does not settle its promise or release its reentrancy guard.
    for (const modal of document.body.querySelectorAll("openclaw-modal-dialog")) {
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    }
    await vi.dynamicImportSettled();
    document.body.replaceChildren();
    await Promise.resolve();
    flush();
    disposeSidebarContextLifecycles();
    // A disconnected Solid sidebar resolves abandoned rendering as false, not another update.
    await Promise.all(Array.from(sidebars, (sidebar) => sidebar.updateComplete));
    frameChannel?.port1.close();
    frameChannel?.port2.close();
    frameChannel = undefined;
    for (const [name, descriptor] of layoutGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  });
}

// Model jsdom's missing :focus-visible only while the keyboard-intent target is focused.
export function focusSidebarPersonWithKeyboard(target: HTMLElement): void {
  const matches = target.matches.bind(target);
  const keyboardFocus = vi
    .spyOn(target, "matches")
    .mockImplementation((selector) =>
      selector === ":focus-visible" ? matches(":focus") : matches(selector),
    );
  onTestFinished(() => keyboardFocus.mockRestore());
  target.focus();
}

export async function selectSidebarView(
  sidebar: HTMLElement & Pick<AppSidebarElement, "updateComplete">,
  view: "pages" | "sessions" | "online",
): Promise<void> {
  const button = sidebar.querySelector<HTMLButtonElement>(`[data-navigation-view="${view}"]`);
  if (!button) {
    throw new Error(`Expected sidebar ${view} control`);
  }
  button.click();
  await sidebar.updateComplete;
}

// General sidebar cases exercise all rows; default-owner regressions mount directly.
export function seedSidebarEveryonePreference(gateway: ApplicationGateway): void {
  const selfUserId = gateway.snapshot.selfUser?.id;
  if (!selfUserId) {
    return;
  }
  const gatewayUrl = gateway.connection.gatewayUrl;
  const key = `openclaw.control.sidebarSessionOwnerFilter.v1:${gatewayOriginScope(gatewayUrl)}:${encodeURIComponent(selfUserId)}`;
  if (localStorage.getItem(key) === null) {
    storeSidebarSessionOwnerFilter(gatewayUrl, selfUserId, { ownerId: null, involvingMe: false });
  }
}

export const manyAgents = (count: number): AgentsListResult => ({
  defaultId: "agent-1",
  mainKey: "main",
  scope: "per-sender",
  agents: Array.from({ length: count }, (_, index) => ({ id: `agent-${index + 1}` })),
});
