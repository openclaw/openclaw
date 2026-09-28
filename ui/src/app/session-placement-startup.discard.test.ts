import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import {
  createPlacementStartupHarness,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";
import createApplicationPlacementStartupRuntime from "./session-placement-startup.runtime.ts";

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("initial turn Discard for placement startup", () => {
  it("retires the retained turn and clears its recovery so it cannot resume on reload", async () => {
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected ${method}`);
    });
    // Confirm the runtime finished loading before discarding so the test exercises the
    // runtime-owner removal path, matching a real send where placement startup is active
    // by the time Discard is shown.
    let loaded = false;
    const { startup, input } = createPlacementStartupHarness(request, {
      recoveryBeforeStartup: true,
      loadRuntime: async () => {
        loaded = true;
        return { default: createApplicationPlacementStartupRuntime };
      },
    });
    const { sessionKey, gatewayUrl, recoveryScope } = input.recovery;
    try {
      startup.resumeRecovery();
      await flushStartupMicrotasks();
      expect(loaded).toBe(true);
      expect(startup.get(sessionKey)).not.toBeNull();
      expect(readSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey)).not.toBeNull();

      startup.discard(sessionKey);

      expect(startup.get(sessionKey)).toBeNull();
      expect(readSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey)).toBeNull();
      // Discard is terminal; no late resume should resurrect the retained turn.
      const callsAtDiscard = request.mock.calls.length;
      await flushStartupMicrotasks();
      expect(startup.get(sessionKey)).toBeNull();
      // No new dispatch or re-check is issued for the discarded startup.
      expect(request.mock.calls.length).toBe(callsAtDiscard);
    } finally {
      startup.dispose();
    }
  });

  it("does not remove another submission that reused the session key", async () => {
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected ${method}`);
    });
    const { startup, input } = createPlacementStartupHarness(request, {
      recoveryBeforeStartup: true,
    });
    const { sessionKey, gatewayUrl, recoveryScope } = input.recovery;
    try {
      startup.resumeRecovery();
      await flushStartupMicrotasks();
      expect(startup.get(sessionKey)).not.toBeNull();

      // A newer submission rotated the stored recovery to a different message id.
      expect(
        writeSessionPlacementRecovery({
          ...input.recovery,
          messageId: "message-newer",
          phase: "paused",
          reason: "not-sent",
          error: "newer attempt",
        }),
      ).toBe(true);

      startup.discard(sessionKey);

      expect(startup.get(sessionKey)).toBeNull();
      // The newer durable recovery row is untouched by discarding the stale entry.
      expect(readSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey)).toMatchObject({
        messageId: "message-newer",
      });
    } finally {
      startup.dispose();
    }
  });
});
