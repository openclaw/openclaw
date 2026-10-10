import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import { observeRootWork } from "../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
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
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!stateDir || !configPath) {
      throw new Error(
        "OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH are required for Gateway E2E fixtures",
      );
    }
    testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");
    try {
      // Keep unrelated reload roots out of the completion settlement barrier.
      await fs.writeFile(configPath, JSON.stringify({ gateway: { reload: { mode: "off" } } }));
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
            [subagent.requesterSessionKey]: {
              sessionId: "requester-blocked-gateway-e2e",
              updatedAt: now,
            },
            [subagent.childSessionKey]: {
              sessionId: "session-blocked-gateway-e2e",
              updatedAt: now,
            },
          },
        });
        await addSubagentRunForTests(subagent);

        // Native suspension completes in detached work. Join its owner before
        // asserting or closing the Gateway, including cold worker startup.
        const settleRootWork = observeRootWork();
        try {
          resumeSubagentRun(subagent.runId);
        } finally {
          await settleRootWork();
        }

        expect(getSubagentRunByRunId(subagent.runId)?.delivery).toMatchObject({
          status: "suspended",
          disposition: "permanent_failure",
          suspendedReason: "expiry",
        });
      });
    } finally {
      await resetSubagentRegistryForTests({ persist: false });
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
    }
  });
});
