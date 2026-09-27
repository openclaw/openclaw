// Registered agent RPC proof for parent-visible session follow-up activity.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createTaskRecord, findTaskByRunId, listTaskRecords } from "../../tasks/task-registry.js";
import { withPluginSubagentTestState } from "./agent-task-tracking.test-helpers.js";
import {
  backendGatewayClient,
  describe0AfterEach0,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  operatorWriteCliClient,
  resetAgentTaskRegistryForTests,
  waitForAssertion,
} from "./agent.test-harness.js";
import { runTaskHandler } from "./tasks.test-helpers.js";

const mocks = getAgentTestMocks();

describe("gateway agent follow-up activity", () => {
  afterEach(describe0AfterEach0);

  it.each(["completed", "yielded"] as const)(
    "shows parent-sent work on a %s child without replacing its previous result or wait",
    async (previousState) => {
      await withPluginSubagentTestState("openclaw-parent-followup-", async ({ stateDir: root }) => {
        resetAgentTaskRegistryForTests();
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
        const previousTask = createTaskRecord({
          runtime: "subagent",
          requesterSessionKey,
          childSessionKey,
          runId: previousRunId,
          task: "Review the candidate",
          status: previousState === "completed" ? "succeeded" : "running",
          deliveryStatus: previousState === "completed" ? "delivered" : "pending",
        });
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
          const { payload } = await runTaskHandler("tasks.list", {
            sessionKey: requesterSessionKey,
            status: ["running"],
          });
          expect(payload?.tasks).toContainEqual(
            expect.objectContaining({
              runId,
              runtime: "cli",
              sessionKey: requesterSessionKey,
              childSessionKey,
              title: "Candidate review",
              status: "running",
              deliveryStatus: "not_applicable",
            }),
          );
          expect(findTaskByRunId(runId)?.notifyPolicy).toBe("silent");
          const callCount = mocks.agentCommand.mock.calls.length;
          await invokeAgent(request, { context, reqId: "replay", client: backendGatewayClient() });
          expect(mocks.agentCommand).toHaveBeenCalledTimes(callCount);
          expect(listTaskRecords().filter((task) => task.runId === runId)).toHaveLength(1);
        } finally {
          run.resolve({ payloads: [], meta: { durationMs: 1 } });
          await waitForAssertion(() => {
            expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" });
          });
        }
        expect(findTaskByRunId(runId)).toMatchObject({
          status: "succeeded",
          deliveryStatus: "not_applicable",
        });
        expect(findTaskByRunId(previousRunId)).toEqual(previousTask);
        expect(getSubagentRunByChildSessionKey(childSessionKey)).toEqual(previousRun);
      });
    },
  );

  it.each([
    { name: "public provenance", publicClient: true, source: "agent:main:parent" },
    { name: "another sender", publicClient: false, source: "agent:main:other" },
    { name: "ACP child", publicClient: false, source: "agent:main:parent", acp: true },
  ])("does not publish parent activity for $name", async ({ publicClient, source, acp }) => {
    await withPluginSubagentTestState("openclaw-followup-scope-", async ({ stateDir: root }) => {
      const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
      mocks.userTurnStorePath = storePath;
      const childSessionKey = `agent:main:${acp ? "acp" : "subagent"}:review`;
      const runId = "untracked-child-followup";
      mocks.updateSessionStore.mockResolvedValue(undefined);
      mocks.agentCommand.mockResolvedValue({ payloads: [], meta: { durationMs: 1 } });
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath,
        entry: {
          sessionId: "spawned-child-session",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:parent",
        },
        canonicalKey: childSessionKey,
      });
      const context = makeContext();
      await invokeAgent(
        {
          message: "Check progress",
          sessionKey: childSessionKey,
          idempotencyKey: runId,
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: source,
            sourceTool: "sessions_send",
          },
        },
        {
          context,
          reqId: runId,
          client: publicClient ? operatorWriteCliClient() : backendGatewayClient(),
        },
      );
      await waitForAssertion(() => {
        expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" });
      });
      expect(findTaskByRunId(runId)).toBeUndefined();
    });
  });
});
