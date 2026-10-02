// Registered agent RPC proof for parent-visible session follow-up activity.
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import * as announceDelivery from "../../agents/subagents/announce/subagent-announce-delivery.js";
import { sourceOwnerChangedResult } from "../../agents/subagents/announce/subagent-announce-dispatch.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import {
  getSubagentRunByRunId,
  initSubagentRegistry,
  resumeSubagentRun,
  registerSubagentRun,
} from "../../agents/subagents/registry/subagent-registry.js";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { upsertSubagentRunRowInDatabase } from "../../agents/subagents/registry/subagent-registry.store.kernel.js";
import { loadSubagentRegistryFromSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
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
        await resetSubagentRegistryForTests({ persist: false });
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
          await addSubagentRunForTests({
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
          await addSubagentRunForTests({
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
              await replaceSubagentRunAfterSteerCore({
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

describe("gateway agent completed-child delivery", () => {
  afterEach(describe0AfterEach0);

  for (const boundary of [
    "transcript read",
    "delivery admission",
    "restored transcript read",
  ] as const) {
    it(`announces both executions when follow-up starts during the first ${boundary}`, async ({
      signal,
    }) => {
      await withPluginSubagentTestState("openclaw-followup-delivery-", async ({ stateDir }) => {
        const registry = await vi.importActual<
          typeof import("../../agents/subagents/registry/subagent-registry.js")
        >("../../agents/subagents/registry/subagent-registry.js");
        const reads = await vi.importActual<
          typeof import("../../agents/subagents/registry/subagent-registry-read.js")
        >("../../agents/subagents/registry/subagent-registry-read.js");
        const announce = await vi.importActual<
          typeof import("../../agents/subagents/announce/subagent-announce.js")
        >("../../agents/subagents/announce/subagent-announce.js");
        mocks.getLatestSubagentRunByChildSessionKey.mockImplementation(
          reads.getLatestSubagentRunByChildSessionKey,
        );
        mocks.replaceSubagentRunAfterSteer.mockImplementation(
          registry.replaceSubagentRunAfterSteerCore,
        );
        const childSessionKey = "agent:main:dashboard:kept-child";
        const requesterSessionKey = "agent:main:main";
        const firstRunId = "first-execution";
        const secondRunId = "second-execution";
        const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        const entry = {
          sessionId: "kept-child-session",
          lifecycleRevision: "kept-child-revision",
          spawnedBy: requesterSessionKey,
          updatedAt: Date.now(),
        };
        sessionAccessor.ensureSessionEntrySync(
          { agentId: "main", storePath, sessionKey: childSessionKey },
          entry,
        );
        sessionAccessor.ensureSessionEntrySync(
          { agentId: "main", storePath, sessionKey: requesterSessionKey },
          {
            sessionId: "parent-session",
            lifecycleRevision: "parent-revision",
            updatedAt: Date.now(),
          },
        );
        mocks.userTurnStorePath = storePath;
        mocks.loadSessionEntry.mockReturnValue({
          cfg: {},
          storePath,
          entry,
          canonicalKey: childSessionKey,
        });
        mocks.updateSessionStore.mockResolvedValue(undefined);
        await addSubagentRunForTests({
          runId: firstRunId,
          childSessionKey,
          childSessionIdentity: entry,
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          task: "First task",
          cleanup: "keep",
          spawnMode: "session",
          expectsCompletionMessage: true,
          completionTarget: "parent",
          generation: 1,
          createdAt: Date.now() - 20,
          execution: {
            status: "terminal",
            startedAt: Date.now() - 20,
            endedAt: Date.now() - 10,
            outcome: { status: "ok" },
            transcriptTarget: {
              agentId: "main",
              storePath,
              sessionKey: childSessionKey,
              sessionId: entry.sessionId,
            },
          },
          completion: {
            required: true,
            terminalReply: { disposition: "visible", text: "FIRST_ONLY" },
          },
          delivery: { status: "pending" },
        });
        const paused = createDeferred();
        const release = createDeferred();
        const firstAnnounceFinished = createDeferred();
        const secondAnnounceFinished = createDeferred();
        const receipts = new Map([
          [firstRunId, createDeferred()],
          [secondRunId, createDeferred()],
        ]);
        const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
          for (const [runId, receipt] of receipts) {
            if (getSubagentRunByRunId(runId)?.cleanupCompletedAt) {
              receipt.resolve();
            }
          }
        });
        mocks.registryAnnounce.mockImplementation(async (params) => {
          try {
            return await announce.runSubagentAnnounceFlow(params);
          } finally {
            (params.childRunId === firstRunId
              ? firstAnnounceFinished
              : secondAnnounceFinished
            ).resolve();
          }
        });
        const transcript = vi
          .spyOn(sessionAccessor, "findTranscriptEvent")
          .mockImplementation(async (_target, match) => {
            expect(match.kind).toBe("visible-final");
            if (match.kind !== "visible-final") {
              throw new Error("Expected an exact-run visible transcript read");
            }
            if (match.runId === firstRunId && boundary !== "delivery admission") {
              paused.resolve();
              await release.promise;
            }
            return {
              event: {
                type: "message",
                message: {
                  role: "assistant",
                  stopReason: "stop",
                  content: [
                    {
                      type: "text",
                      text: match.runId === firstRunId ? "FIRST_ONLY" : "SECOND_ONLY",
                    },
                  ],
                  __openclaw: { runId: match.runId },
                },
              },
            };
          });
        const handoffs: Parameters<typeof announceDelivery.deliverSubagentAnnouncement>[0][] = [];
        const deliver = vi
          .spyOn(announceDelivery, "deliverSubagentAnnouncement")
          .mockImplementation(async (params) => {
            if (params.sourceRunId === firstRunId && boundary === "delivery admission") {
              paused.resolve();
              await release.promise;
            }
            if (params.isSourceSessionEffectsAllowed?.() === false) {
              return sourceOwnerChangedResult();
            }
            handoffs.push(params);
            return {
              delivered: true,
              disposition: "delivered",
              path: "direct",
              deliveredAt: Date.now(),
            };
          });
        const provider = createDeferred<{
          payloads: { text: string }[];
          meta: { durationMs: number };
        }>();
        const secondWait = createDeferred<{
          status: "ok";
          startedAt: number;
          endedAt: number;
          terminalReply: { disposition: "visible"; text: string };
        }>();
        const commandStarted = createDeferred();
        mocks.agentCommand.mockImplementationOnce(() => {
          commandStarted.resolve();
          return provider.promise;
        });
        mocks.registryCallGateway.mockImplementation(async (request) => {
          if (request.method !== "agent.wait") {
            throw new Error(`Unexpected child-session effect: ${request.method}`);
          }
          expect(request.params).toMatchObject({ runId: secondRunId });
          return await secondWait.promise;
        });
        const context = makeContext();
        const client = backendGatewayClient();
        const terminal = createDeferred();
        const respond = vi.fn((ok, payload) => {
          if (!ok || payload?.status === "ok" || payload?.status === "error") {
            terminal.resolve();
          }
        });
        let admitted = false;
        try {
          if (boundary === "restored transcript read") {
            await restoreSubagentRunsFromDisk({ runs: subagentRuns });
          }
          resumeSubagentRun(firstRunId);
          await withinTest(paused.promise, signal);
          await invokeAgent(
            {
              sessionKey: childSessionKey,
              message: "Second task",
              idempotencyKey: secondRunId,
            },
            { context, respond, reqId: secondRunId, client, flushDispatch: false },
          );
          admitted = true;
          await withinTest(commandStarted.promise, signal);
          expect(getSubagentRunByRunId(secondRunId)).toMatchObject({
            generation: 2,
            task: "Second task",
            execution: { status: "running" },
          });
          if (boundary === "restored transcript read") {
            expect(loadSubagentRegistryFromSqlite().get(firstRunId)).toMatchObject({
              runId: firstRunId,
              generation: 1,
              execution: { status: "terminal", outcome: { status: "ok" } },
              completion: { terminalReply: { disposition: "visible", text: "FIRST_ONLY" } },
              delivery: { status: "pending" },
            });
          }
          release.resolve();
          await withinTest(firstAnnounceFinished.promise, signal);
          expect(handoffs).toHaveLength(1);
          expect(handoffs[0]).toMatchObject({
            sourceRunId: firstRunId,
            directIdempotencyKey: `announce:v1:${childSessionKey}:${firstRunId}`,
            internalEvents: [{ taskLabel: "First task", status: "ok", result: "FIRST_ONLY" }],
          });
          await withinTest(receipts.get(firstRunId)!.promise, signal);
          expect(getSubagentRunByRunId(firstRunId)?.delivery).toMatchObject({
            status: "delivered",
            deliveredAt: expect.any(Number),
          });
          expect(getSubagentRunByRunId(secondRunId)).toMatchObject({
            execution: { status: "running" },
            delivery: { status: "pending" },
            cleanupHandled: false,
          });
          expect(
            sessionAccessor.loadSessionEntryReadOnly({
              agentId: "main",
              storePath,
              sessionKey: childSessionKey,
            }),
          ).toMatchObject(entry);
          provider.resolve({ payloads: [{ text: "SECOND_ONLY" }], meta: { durationMs: 1 } });
          secondWait.resolve({
            status: "ok",
            startedAt: Date.now() - 1,
            endedAt: Date.now(),
            terminalReply: { disposition: "visible", text: "SECOND_ONLY" },
          });
          await withinTest(terminal.promise, signal);
          await withinTest(secondAnnounceFinished.promise, signal);
          await withinTest(receipts.get(secondRunId)!.promise, signal);
          expect(handoffs).toHaveLength(2);
          expect(handoffs[1]).toMatchObject({
            sourceRunId: secondRunId,
            directIdempotencyKey: `announce:v1:${childSessionKey}:${secondRunId}`,
            internalEvents: [{ taskLabel: "Second task", status: "ok", result: "SECOND_ONLY" }],
          });
          expect(getSubagentRunByRunId(secondRunId)?.delivery).toMatchObject({
            status: "delivered",
            deliveredAt: expect.any(Number),
          });
          resumeSubagentRun(firstRunId);
          resumeSubagentRun(secondRunId);
          await registryTesting.sweepOnceForTests();
          await settleSubagentRegistryPersistenceWork();
          expect(handoffs).toHaveLength(2);
        } finally {
          release.resolve();
          provider.resolve({ payloads: [{ text: "SECOND_ONLY" }], meta: { durationMs: 1 } });
          secondWait.resolve({
            status: "ok",
            startedAt: Date.now() - 1,
            endedAt: Date.now(),
            terminalReply: { disposition: "visible", text: "SECOND_ONLY" },
          });
          if (admitted) {
            await terminal.promise;
          }
          await resetSubagentRegistryForTests({ persist: false });
          unsubscribe();
          transcript.mockRestore();
          deliver.mockRestore();
          mocks.getLatestSubagentRunByChildSessionKey.mockReset();
          mocks.replaceSubagentRunAfterSteer.mockReset();
        }
      });
    });
  }
});
