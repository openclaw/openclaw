import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { seedSubagentCompletionDelivery } from "../agents/subagents/completion/subagent-completion-admission.test-helpers.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  resumeSubagentRun,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

vi.mock("../agents/subagents/announce/subagent-announce.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/subagents/announce/subagent-announce.js")>()),
  runSubagentAnnounceFlow: async () => "retryable",
}));
vi.mock("../agents/subagents/announce/subagent-announce.requester-settle-wake.js", () => ({
  maybeWakeRequesterAfterAllChildrenSettled: async () => false,
}));

installGatewayTestHooks({ scope: "suite" });

describe("subagent completion blocked Gateway E2E", () => {
  it("suspends native completion delivery after ordinary delivery exhaustion", async () => {
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for Gateway E2E fixtures");
    }
    testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");
    try {
      await withGatewayServer(async () => {
        const now = Date.now();
        const endedAt = now - 31 * 60_000;
        const subagent = createSubagentRunRecord({
          runId: "subagent-run-blocked-gateway-e2e",
          childSessionKey: "agent:main:subagent:blocked-gateway-e2e",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "agent:main:main",
          requesterAgentId: "main",
          task: "finish the Gateway exhaustion proof",
          createdAt: endedAt - 1_000,
          endedAt,
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          completion: { required: true, resultText: "proof result", capturedAt: endedAt },
          delivery: {
            status: "pending",
            disposition: "retryable",
            generation: 1,
            windowStartedAt: endedAt,
            deadlineAt: endedAt + 30 * 60_000,
            lastError: "requester unavailable",
          },
        });

        await writeSessionStore({
          entries: {
            [subagent.childSessionKey]: {
              sessionId: "session-blocked-gateway-e2e",
              updatedAt: now,
            },
          },
        });
        seedSubagentCompletionDelivery({ subagent });
        addSubagentRunForTests(subagent);

        resumeSubagentRun(subagent.runId);

        await vi.waitFor(() => {
          expect(getSubagentRunByRunId(subagent.runId)?.delivery).toMatchObject({
            status: "suspended",
            disposition: "permanent_failure",
            suspendedReason: "expiry",
          });
        });
      });
    } finally {
      resetSubagentRegistryForTests({ persist: false });
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
    }
  });
});
