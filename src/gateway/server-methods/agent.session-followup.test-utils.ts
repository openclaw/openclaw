// Registered agent RPC proof for parent-visible session follow-up activity.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { withPluginSubagentTestState } from "./agent.spawned-child.test-support.js";
import {
  backendGatewayClient,
  describe0AfterEach0,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  waitForAssertion,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent follow-up activity", () => {
  afterEach(describe0AfterEach0);

  it.each(["completed", "yielded"] as const)(
    "executes parent-sent work on a %s child without replacing its previous result or wait",
    async (previousState) => {
      await withPluginSubagentTestState("openclaw-parent-followup-", async ({ stateDir: root }) => {
        resetSubagentRegistryForTests({ persist: false });
        const requesterSessionKey = "agent:main:main";
        const childSessionKey = "agent:main:subagent:review";
        const previousRunId = "previous-review";
        const runId = "continued-review";
        addSubagentRunForTests({
          runId: previousRunId,
          childSessionKey,
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          task: "Review the candidate",
          startedAt: 1,
          endedAt: 2,
          ...(previousState === "yielded" ? { pauseReason: "sessions_yield" as const } : {}),
          expectsCompletionMessage: true,
        });
        const previousRun = structuredClone(getSubagentRunByChildSessionKey(childSessionKey));
        mocks.updateSessionStore.mockResolvedValue(undefined);
        const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
        mocks.userTurnStorePath = storePath;
        mocks.loadSessionEntry.mockReturnValue({
          cfg: {},
          storePath,
          entry: {
            sessionId: "spawned-child-session",
            updatedAt: Date.now(),
            spawnedBy: requesterSessionKey,
            label: "Candidate review",
          },
          canonicalKey: childSessionKey,
        });
        const run = createDeferred<{ payloads: []; meta: { durationMs: number } }>();
        mocks.agentCommand.mockReturnValueOnce(run.promise);
        const context = makeContext();
        const request = {
          message: "Continue reviewing the new changes",
          sessionKey: childSessionKey,
          idempotencyKey: runId,
          inputProvenance: {
            kind: "inter_session" as const,
            sourceSessionKey: requesterSessionKey,
            sourceTool: "sessions_send",
          },
        };
        try {
          await invokeAgent(request, { context, reqId: runId, client: backendGatewayClient() });
          expect(context.chatAbortControllers.get(runId)?.sessionKey).toBe(childSessionKey);
          const callCount = mocks.agentCommand.mock.calls.length;
          await invokeAgent(request, { context, reqId: "replay", client: backendGatewayClient() });
          expect(mocks.agentCommand).toHaveBeenCalledTimes(callCount);
        } finally {
          run.resolve({ payloads: [], meta: { durationMs: 1 } });
          await waitForAssertion(() => {
            expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" });
          });
        }
        expect(getSubagentRunByChildSessionKey(childSessionKey)).toEqual(previousRun);
      });
    },
  );
});
