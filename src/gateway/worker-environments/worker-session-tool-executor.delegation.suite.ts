import { describe, expect, it } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  installWorkerSessionToolTestFixture,
  SOURCE,
  workerSessionToolTestMocks,
} from "./worker-session-tool-executor.test-support.js";

export function registerWorkerDelegationPolicyTests(
  mocks: ReturnType<typeof workerSessionToolTestMocks>,
) {
  describe("initial worker delegation", () => {
    const getFixture = installWorkerSessionToolTestFixture(mocks, {});
    it("refuses an explicit target before child effects and replays the refusal", async () => {
      const { setEntry, execute, identity } = getFixture();
      setEntry(SOURCE.sessionKey, SOURCE.sessionId);
      const original = getRuntimeConfig();
      setRuntimeConfigSnapshot({
        ...original,
        agents: {
          entries: {
            main: {
              tools: { deny: ["exec", "write"] },
              subagents: { allowAgents: ["coder"], delegateToolsTo: ["coder"] },
            },
            coder: {},
          },
        },
      });
      try {
        const request = {
          identity,
          toolName: "sessions_spawn" as const,
          request: { toolCallId: "initial-grant", task: "implement", agentId: "coder" },
        };
        const first = await execute(request);
        const replay = await execute(request);
        expect(replay.resultJson).toBe(first.resultJson);
        expect(first.resultJson).toContain("requires a host-prepared deny-only policy");
        expect(mocks.gatewayCreate).not.toHaveBeenCalled();
        expect(mocks.dispatchChild).not.toHaveBeenCalled();
        expect(mocks.gatewayRequest).not.toHaveBeenCalled();
      } finally {
        setRuntimeConfigSnapshot(original);
      }
    });
  });
  describe.each([
    {
      name: "sender-restricted",
      options: { inheritedToolPolicySource: "sender" as const },
      error: "This sender may only start hidden helpers of the same agent.",
    },
    {
      name: "delegated",
      options: { delegatedToolPolicyActive: true },
      error:
        "Worker-originated child spawning cannot preserve this delegated execution grant. Start the helper from a Gateway-side native session.",
    },
  ])("$name worker session creation", ({ options, error }) => {
    const getFixture = installWorkerSessionToolTestFixture(mocks, options);
    it("refuses forced visible creation before child effects and replays the refusal", async () => {
      const { setEntry, spawn } = getFixture();
      setEntry(SOURCE.sessionKey, SOURCE.sessionId);
      const first = await spawn("restricted-worker-spawn");
      const replay = await spawn("restricted-worker-spawn");
      expect(replay.resultJson).toBe(first.resultJson);
      expect(JSON.parse(first.resultJson)).toMatchObject({
        details: { status: "forbidden", error },
      });
      expect(mocks.gatewayCreate).not.toHaveBeenCalled();
      expect(mocks.dispatchChild).not.toHaveBeenCalled();
      expect(mocks.gatewayRequest).not.toHaveBeenCalled();
    });
  });
}
