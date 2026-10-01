// Registered agent RPC proof for parent-visible session follow-up activity.
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  initSubagentRegistry,
  registerSubagentRun,
} from "../../agents/subagents/registry/subagent-registry.js";
import { upsertSubagentRunRowInDatabase } from "../../agents/subagents/registry/subagent-registry.store.kernel.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import * as admissionController from "../agent-turn/agent-admission-controller.js";
import { resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import { withPluginSubagentTestState } from "./agent.spawned-child.test-support.js";
import {
  backendGatewayClient,
  describe0AfterEach0,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent follow-up activity", () => {
  afterEach(describe0AfterEach0);

  it.each([
    { label: "registered default child follow-up" },
    { label: "completed unlimited child follow-up", previousState: "completed", budget: 0 },
    { label: "yielded unlimited child follow-up", previousState: "yielded", budget: 0 },
    { label: "completed finite child follow-up", previousState: "completed", budget: 90 },
    { label: "yielded finite child follow-up", previousState: "yielded", budget: 90 },
    {
      label: "visible unlimited requester completion wake",
      budget: 0,
      sourceTool: "subagent_announce",
      visible: true,
    },
    {
      label: "nested finite requester completion wake",
      budget: 90,
      sourceTool: "subagent_announce",
    },
    {
      label: "visible unlimited requester settle wake",
      budget: 0,
      sourceTool: "subagent_settle",
      visible: true,
    },
    {
      label: "top-level requester default wake",
      sourceTool: "subagent_settle",
      unregistered: true,
    },
    {
      label: "top-level requester configured wake",
      sourceTool: "subagent_announce",
      unregistered: true,
      configuredTimeout: 1200,
    },
    { label: "explicit override on unlimited child", budget: 0, timeout: 25 },
    { label: "retired child uses the agent default", budget: 0, retired: true },
    {
      label: "recreated child uses the agent default",
      budget: 0,
      priorSessionId: "retired-session",
    },
    { label: "reset child uses the agent default", budget: 90, priorRevision: "retired-revision" },
    { label: "session id rotated during admission wait", budget: 0, rotation: "sessionId" },
    { label: "lifecycle revision rotated during admission wait", budget: 90, rotation: "revision" },
    { label: "unbound unlimited registration", budget: 0, missingIdentity: true },
    {
      label: "v2026.9.6 persisted unlimited nested settle wake",
      budget: 0,
      persisted: true,
      sourceTool: "subagent_settle",
      configuredTimeout: 1200,
    },
    {
      label: "v2026.9.6 persisted finite nested settle wake",
      budget: 90,
      persisted: true,
      sourceTool: "subagent_settle",
    },
    { label: "initial unlimited registration", budget: 0, register: true },
    { label: "initial finite registration", budget: 90, register: true },
    { label: "recreated unlimited registration", budget: 0, register: true, recreate: true },
    { label: "recreated finite registration", budget: 90, register: true, recreate: true },
    { label: "successor finite registration", budget: 90, register: true, replace: true },
    { label: "redirected transcript", budget: 0, hiddenTranscript: true },
    { label: "unversioned initial registration", budget: 0, register: true, unversioned: true },
    {
      label: "unversioned reset registration",
      budget: 90,
      register: true,
      unversioned: true,
      revise: true,
    },
  ])(
    "preserves timeout policy and prior completion for $label",
    async ({
      previousState,
      budget,
      sourceTool = "sessions_send",
      visible,
      unregistered,
      configuredTimeout,
      timeout,
      retired,
      priorSessionId,
      priorRevision,
      rotation,
      missingIdentity,
      persisted,
      register,
      recreate,
      unversioned,
      revise,
      replace,
      hiddenTranscript,
    }) => {
      await withPluginSubagentTestState("openclaw-parent-followup-", async ({ stateDir: root }) => {
        resetSubagentRegistryForTests({ persist: false });
        const requesterSessionKey = "agent:main:main";
        const childSessionKey = unregistered
          ? "agent:main:dashboard:parent"
          : visible
            ? "agent:main:dashboard:review"
            : "agent:main:subagent:review";
        const cfg =
          configuredTimeout === undefined
            ? {}
            : { agents: { defaults: { timeoutSeconds: configuredTimeout } } };
        mocks.loadConfigReturn = cfg;
        const previousRunId = "previous-review";
        const runId = "continued-review";
        if (!unregistered && !register && !persisted) {
          addSubagentRunForTests({
            runId: previousRunId,
            runTimeoutSeconds: budget,
            childSessionKey,
            requesterSessionKey,
            requesterDisplayKey: requesterSessionKey,
            task: "Review the candidate",
            childSessionIdentity: missingIdentity
              ? undefined
              : {
                  sessionId: priorSessionId ?? "spawned-child-session",
                  lifecycleRevision: priorRevision ?? "current-revision",
                },
            execution: {
              status: "terminal",
              startedAt: 1,
              endedAt: 2,
              ...(retired ? { suppressSessionEffects: true } : {}),
              transcriptTarget: hiddenTranscript ? { sessionId: "hidden-transcript" } : undefined,
            },
            ...(previousState === "yielded" ? { pauseReason: "sessions_yield" as const } : {}),
            expectsCompletionMessage: true,
          });
        }
        if (sourceTool !== "sessions_send") {
          addSubagentRunForTests({
            runId: "settled-grandchild",
            childSessionKey: "agent:main:subagent:grandchild",
            requesterSessionKey: childSessionKey,
            requesterDisplayKey: childSessionKey,
            task: "Report findings",
            startedAt: 1,
            endedAt: 2,
            runTimeoutSeconds: 1,
          });
        }
        mocks.updateSessionStore.mockResolvedValue(undefined);
        const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
        mocks.userTurnStorePath = storePath;
        let currentEntry = {
          sessionId: "spawned-child-session",
          lifecycleRevision: unversioned ? undefined : "current-revision",
          updatedAt: Date.now(),
          spawnedBy: requesterSessionKey,
          label: "Candidate review",
        };
        mocks.loadSessionEntry.mockImplementation(() => ({
          cfg,
          storePath,
          entry: currentEntry,
          canonicalKey: childSessionKey,
        }));
        if (persisted) {
          // Frozen v2026.9.6 (eb377ac59e6c) codec/normalizer output after sessions_yield.
          // Seed the released bytes without passing through the candidate's serializer.
          runOpenClawStateWriteTransaction((database) =>
            upsertSubagentRunRowInDatabase(database, {
              run_id: previousRunId,
              child_session_key: childSessionKey,
              controller_session_key: requesterSessionKey,
              requester_session_key: requesterSessionKey,
              requester_store_path: storePath,
              controller_store_path: storePath,
              created_at: 1,
              payload_json: JSON.stringify({
                runId: previousRunId,
                taskRunId: previousRunId,
                childSessionKey,
                controllerSessionKey: requesterSessionKey,
                requesterSessionKey,
                requesterStorePath: storePath,
                controllerStorePath: storePath,
                requesterDisplayKey: requesterSessionKey,
                requesterAgentId: "main",
                task: "Review the candidate",
                cleanup: "keep",
                expectsCompletionMessage: true,
                spawnMode: "run",
                runTimeoutSeconds: budget,
                generation: 1,
                createdAt: 1,
                execution: {
                  status: "terminal",
                  startedAt: 1,
                  endedAt: 2,
                  lifecycleGeneration: "released-generation",
                },
                completion: { required: true },
                delivery: { status: "pending" },
                sessionStartedAt: 1,
                accumulatedRuntimeMs: 0,
                cleanupHandled: false,
                pauseReason: "sessions_yield",
              }),
            }),
          );
          expect(getSubagentRunByChildSessionKey(childSessionKey)).toBeNull();
          await initSubagentRegistry();
          expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
            runId: previousRunId,
            runTimeoutSeconds: budget,
            pauseReason: "sessions_yield",
          });
          expect(getSubagentRunByChildSessionKey(childSessionKey)).not.toHaveProperty(
            "childSessionIdentity",
          );
        }
        if (register) {
          await registerSubagentRun({
            runId: previousRunId,
            childSessionKey,
            requesterSessionKey,
            requesterDisplayKey: requesterSessionKey,
            task: "Review the candidate",
            cleanup: "keep",
            runTimeoutSeconds: budget,
            sessionEntry: currentEntry,
          });
          if (replace) {
            const { replaceSubagentRunAfterSteerCore } = await vi.importActual<
              typeof import("../../agents/subagents/registry/subagent-registry.js")
            >("../../agents/subagents/registry/subagent-registry.js");
            expect(
              replaceSubagentRunAfterSteerCore({
                previousRunId,
                nextRunId: "successor-review",
              }),
            ).toBe(true);
          }
          if (recreate) {
            currentEntry = {
              ...currentEntry,
              sessionId: "recreated-child-session",
              lifecycleRevision: "recreated-revision",
            };
          } else if (revise) {
            currentEntry = { ...currentEntry, lifecycleRevision: "new-revision" };
          }
        }
        const previousRun = structuredClone(getSubagentRunByChildSessionKey(childSessionKey));
        const admissionStarted = createDeferred();
        const releaseAdmission = createDeferred();
        const createController = admissionController.createAgentAdmissionController;
        const admissionSpy = rotation
          ? vi
              .spyOn(admissionController, "createAgentAdmissionController")
              .mockImplementation((params) => {
                const controller = createController(params);
                return {
                  ...controller,
                  acquire: async (scope) => {
                    if (controller.getAdmission()) {
                      admissionStarted.resolve();
                      await releaseAdmission.promise;
                    }
                    await controller.acquire(scope);
                  },
                };
              })
          : undefined;
        const run = createDeferred<{ payloads: []; meta: { durationMs: number } }>();
        mocks.agentCommand.mockReturnValueOnce(run.promise);
        const context = makeContext();
        const request = {
          message: "Continue reviewing the new changes",
          sessionKey: childSessionKey,
          idempotencyKey: runId,
          ...(timeout === undefined ? {} : { timeout }),
          inputProvenance: {
            kind: "inter_session" as const,
            sourceSessionKey:
              sourceTool === "sessions_send"
                ? requesterSessionKey
                : "agent:main:subagent:grandchild",
            sourceTool,
          },
        };
        const terminal = createDeferred();
        const respond = vi.fn((ok, payload) => {
          if (ok && payload?.status === "ok") {
            terminal.resolve();
          }
        });
        try {
          const pending = invokeAgent(request, {
            context,
            respond,
            reqId: runId,
            client: backendGatewayClient(),
          });
          if (rotation) {
            await admissionStarted.promise;
            currentEntry = {
              ...currentEntry,
              sessionId: rotation === "sessionId" ? "replacement-session" : currentEntry.sessionId,
              lifecycleRevision: "replacement-revision",
            };
            releaseAdmission.resolve();
          }
          await pending;
          const expectedSeconds =
            timeout ??
            (unregistered ||
            retired ||
            priorSessionId ||
            priorRevision ||
            rotation ||
            missingIdentity ||
            persisted ||
            recreate ||
            revise
              ? undefined
              : (budget ?? 0));
          expect(mocks.agentCommand.mock.calls.at(-1)?.[0].timeout).toBe(
            expectedSeconds?.toString(),
          );
          const admitted = context.chatAbortControllers.get(runId)!;
          expect(admitted.sessionId).toBe(currentEntry.sessionId);
          expect(mocks.agentCommand.mock.calls.at(-1)?.[0].sessionId).toBe(currentEntry.sessionId);
          const expectedMs =
            expectedSeconds === 0
              ? MAX_TIMER_TIMEOUT_MS
              : (expectedSeconds ?? configuredTimeout ?? 172_800) * 1000;
          expect(admitted.expiresAtMs).toBe(
            resolveAgentRunExpiresAtMs({ now: admitted.startedAtMs, timeoutMs: expectedMs }),
          );
          expect(context.chatAbortControllers.get(runId)?.sessionKey).toBe(childSessionKey);
          const callCount = mocks.agentCommand.mock.calls.length;
          await invokeAgent(request, { context, reqId: "replay", client: backendGatewayClient() });
          expect(mocks.agentCommand).toHaveBeenCalledTimes(callCount);
        } finally {
          releaseAdmission.resolve();
          admissionSpy?.mockRestore();
          run.resolve({ payloads: [], meta: { durationMs: 1 } });
          await terminal.promise;
          expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" });
        }
        if (persisted) {
          expect(getSubagentRunByChildSessionKey(childSessionKey)).toMatchObject({
            runId,
            taskRunId: previousRunId,
            runTimeoutSeconds: budget,
            generation: 2,
            requesterSessionKey,
            execution: { status: "running" },
          });
          expect(getSubagentRunByChildSessionKey(childSessionKey)).not.toHaveProperty(
            "childSessionIdentity",
          );
        } else {
          expect(getSubagentRunByChildSessionKey(childSessionKey)).toEqual(previousRun);
        }
      });
    },
  );
});
