import { describe, expect, it } from "vitest";
import {
  installWorkerSessionToolTestFixture,
  SOURCE,
  workerSessionToolTestMocks,
} from "./worker-session-tool-executor.test-support.js";

export function registerWorkerDelegationPolicyTests(
  mocks: ReturnType<typeof workerSessionToolTestMocks>,
) {
  describe("sender-restricted worker session creation", () => {
    const getFixture = installWorkerSessionToolTestFixture(mocks, {
      inheritedToolPolicySource: "sender",
    });
    it("refuses forced visible creation before child effects and replays the refusal", async () => {
      const { setEntry, spawn } = getFixture();
      setEntry(SOURCE.sessionKey, SOURCE.sessionId);
      const first = await spawn("restricted-worker-spawn");
      const replay = await spawn("restricted-worker-spawn");
      expect(replay.resultJson).toBe(first.resultJson);
      expect(JSON.parse(first.resultJson)).toMatchObject({
        details: {
          status: "forbidden",
          error: "This sender may only start hidden helpers of the same agent.",
        },
      });
      expect(mocks.gatewayCreate).not.toHaveBeenCalled();
      expect(mocks.dispatchChild).not.toHaveBeenCalled();
      expect(mocks.gatewayRequest).not.toHaveBeenCalled();
    });
  });
}
