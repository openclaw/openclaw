import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureChoicePromptSelector,
  type TestChoiceSelector,
} from "./components/choice-prompt.test-support.js";
import { createOverlayHandle } from "./tui-overlay-handle.test-support.js";

export function createPendingRequests() {
  const cleanups: Array<() => Promise<void>> = [];
  return {
    pending<T>(this: void, fallback: T) {
      const result = createDeferred<T>();
      cleanups.push(async () => {
        result.resolve(fallback);
        await Promise.allSettled([result.promise]);
        await new Promise(setImmediate);
      });
      return result;
    },
    async cleanupPending(this: void) {
      for (const cleanup of cleanups.splice(0)) {
        await cleanup();
      }
    },
  };
}

export function createChoicePromptHarness() {
  let agentId = "main";
  let sessionKey = "agent:main:main";
  const selectors: TestChoiceSelector[] = [];
  const overlayHandles: OverlayHandle[] = [];
  return {
    selectors,
    overlayHandles,
    addSystem: vi.fn(),
    closeOverlay: vi.fn(),
    requestRender: vi.fn(),
    getAgentId: () => agentId,
    getSessionKey: () => sessionKey,
    setAgentId: (value: string) => {
      agentId = value;
    },
    setSessionKey: (value: string) => {
      sessionKey = value;
    },
    openOverlay: vi.fn((component: Component) => {
      selectors.push(captureChoicePromptSelector(component));
      const handle = createOverlayHandle();
      overlayHandles.push(handle);
      return handle;
    }),
  };
}
