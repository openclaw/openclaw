import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import * as preparedRuntime from "../../../src/agents/prepared-model-runtime.js";
import { createSubagentRunRecord } from "../../../src/agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../../../src/agents/subagents/registry/subagent-registry-memory.js";
import * as restartRecovery from "../../../src/agents/subagents/registry/subagent-registry-restart-recovery.js";
import {
  expectReleasedCoreSubagentCandidatePersisted,
  settleSubagentRegistryPersistenceWork,
  writeReleasedCoreSubagentCandidateFixture,
  writeSubagentSessionEntry,
} from "../../../src/agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../../../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  registerSubagentRun,
  releaseSubagentRun,
  resetSubagentRegistryForTests,
} from "../../../src/agents/subagents/registry/subagent-registry.test-helpers.js";
import { loadSessionEntry } from "../../../src/config/sessions/session-accessor.js";
import {
  SQLITE_SESSION_WRITER_QUEUES,
  WRITER_QUEUES,
} from "../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { AgentTurnStartOwner } from "../../../src/gateway/agent-turn/internal-facade.types.js";
import type { GatewayRecoveryRuntime } from "../../../src/gateway/server-instance-runtime.types.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../src/gateway/test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../../../src/gateway/test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "../../../src/gateway/test-openai-responses-model.js";
import { withTimeout } from "../../../src/infra/fs-safe.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../src/infra/kysely-sync.js";
import type { DB } from "../../../src/state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../../src/state/openclaw-state-db.js";
import * as taskControlRuntime from "../../../src/tasks/task-registry-control.runtime.js";
import { cancelTaskById, findTaskByRunId, getTaskById } from "../../../src/tasks/task-registry.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryControlRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
} from "../../../src/tasks/task-runtime.test-helpers.js";
import { captureEnv } from "../../../src/test-utils/env.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../../src/test-utils/session-state-cleanup.js";
import { writeOpenAiResponsesText } from "../openai-responses-sse.js";
import { createDeferred } from "../promise.js";
import { runQaGatewayFixture } from "../qa-gateway-cleanup.js";

type RecoverySource = "A" | "B" | "other";
type MarkerLocation =
  | "instructions"
  | "latest-user"
  | "earlier-user"
  | "assistant"
  | "tool"
  | "other-unknown";

function summarizePostMarkers(body: string) {
  const released: MarkerLocation[] = [];
  const successor: MarkerLocation[] = [];
  const inspect = (value: unknown, location: MarkerLocation) => {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    for (const [marker, locations] of [
      ["RELEASED_OWNER_WORK", released],
      ["NEW_OWNER_WORK", successor],
    ] as const) {
      if (text.includes(marker) && !locations.includes(location)) {
        locations.push(location);
      }
    }
  };
  try {
    const payload = asOptionalRecord(JSON.parse(body));
    if (!payload) {
      inspect(body, "other-unknown");
      return { released, successor };
    }
    inspect(payload.instructions, "instructions");
    const input = payload.input;
    if (Array.isArray(input)) {
      const lastUser = input.findLastIndex((item) => asOptionalRecord(item)?.role === "user");
      for (const [index, item] of input.entries()) {
        const entry = asOptionalRecord(item);
        const role = entry?.role;
        inspect(
          item,
          role === "user"
            ? index === lastUser
              ? "latest-user"
              : "earlier-user"
            : role === "assistant"
              ? "assistant"
              : role === "system" || role === "developer"
                ? "instructions"
                : role === "tool" ||
                    entry?.type === "function_call" ||
                    entry?.type === "function_call_output"
                  ? "tool"
                  : "other-unknown",
        );
      }
    } else {
      inspect(input, typeof input === "string" ? "latest-user" : "other-unknown");
    }
    for (const [key, value] of Object.entries(payload)) {
      if (key !== "instructions" && key !== "input") {
        inspect(value, "other-unknown");
      }
    }
  } catch {
    inspect(body, "other-unknown");
  }
  return { released, successor };
}

function readDurableOwnership() {
  const { db } = openOpenClawStateDatabase();
  const query = getNodeSqliteKysely<Pick<DB, "subagent_runs" | "task_runs" | "flow_runs">>(db);
  return {
    runs: executeSqliteQuerySync(
      db,
      query.selectFrom("subagent_runs").selectAll().orderBy("run_id"),
    ).rows,
    tasks: executeSqliteQuerySync(db, query.selectFrom("task_runs").selectAll().orderBy("task_id"))
      .rows,
    flows: executeSqliteQuerySync(db, query.selectFrom("flow_runs").selectAll().orderBy("flow_id"))
      .rows,
  };
}

describe("released subagent ownership through the real Gateway", () => {
  it.for(["allowed", "cancelled", "retained", "completed", "removed"] as const)(
    "revalidates %s after real runtime preparation",
    { timeout: 90_000 },
    async (mode, { onTestFailed }) => {
      const token = "released-subagent-ownership-token";
      const state = await createOpenClawTestState({
        label: "released-subagent-ownership",
        applyEnv: false,
        env: {
          OPENCLAW_GATEWAY_TOKEN: token,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });
      const environment = captureEnv([
        ...Object.keys(state.envVars),
        ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
      ]);
      const runId = "released-predecessor";
      const successorRunId = "released-new-owner";
      const childSessionKey = "agent:main:subagent:released-owner";
      const sessionId = "released-owner-session";
      const lifecycleRevision = "released-owner-revision";
      const task = "Continue RELEASED_OWNER_WORK after the interrupted turn.";
      const marker = "RELEASED_OWNER_COMPLETED";
      const recoveryPosts: string[] = [];
      const successorPosts: string[] = [];
      const diagnosticStarted = performance.now();
      const events: Array<{
        n: number;
        ms: number;
        phase:
          | "recovery"
          | "dispatch"
          | "start-owner"
          | "execution"
          | "settled"
          | "rejected"
          | "lease-held"
          | "lease-released"
          | "snapshot";
        source: RecoverySource;
        target?: "child" | "requester" | "other";
        guard?: boolean;
        accepted?: boolean;
      }> = [];
      const posts: Array<
        ReturnType<typeof summarizePostMarkers> & { n: number; dispatchEvent: number }
      > = [];
      const checkpoints = {
        aOwnerObserved: false,
        aPreexecution: false,
        aCallbackUnseen: false,
        aDispatchPending: false,
        bTerminal: false,
        bDelivered: false,
        bTaskSucceeded: false,
        bSessionDone: false,
        bLastRunMatches: false,
        bLifecycleCleared: false,
        bWritesSettled: false,
      };
      let eventCount = 0;
      let postCount = 0;
      let droppedEvents = 0;
      let lastDispatchEvent = 0;
      let diagnosticEmitted = false;
      const sourceOf = (source: string | undefined): RecoverySource =>
        source === runId ? "A" : source === successorRunId ? "B" : "other";
      const record = (
        phase: (typeof events)[number]["phase"],
        source: RecoverySource,
        fields: Pick<(typeof events)[number], "target" | "guard" | "accepted"> = {},
      ) => {
        const n = ++eventCount;
        events.push({
          n,
          ms: Math.round(performance.now() - diagnosticStarted),
          phase,
          source,
          ...fields,
        });
        if (events.length > 24) {
          events.shift();
          droppedEvents++;
        }
        return n;
      };
      const emitFailureDiagnostic = () => {
        if (diagnosticEmitted) {
          return;
        }
        diagnosticEmitted = true;
        const render = () =>
          `[released-ownership] ${JSON.stringify({
            mode,
            checkpoints,
            events,
            posts,
            droppedEvents,
            droppedPosts: postCount - posts.length,
          })}\n`;
        let line = render();
        while (Buffer.byteLength(line) > 4_096 && (events.length > 0 || posts.length > 0)) {
          if (events.length > 0) {
            events.shift();
            droppedEvents++;
          } else {
            posts.pop();
          }
          line = render();
        }
        try {
          process.stderr.write(line);
        } catch {
          // Diagnostics must not replace the fixture's original failure.
        }
      };
      onTestFailed(emitFailureDiagnostic);
      const providerWork = new Set<Promise<void>>();
      const providerErrors: unknown[] = [];
      const provider = createServer((request, response) => {
        const work = (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks).toString("utf8");
          postCount++;
          if (posts.length < 4) {
            // Marker locations and ordering do not identify a POST's originating run.
            posts.push({
              n: postCount,
              dispatchEvent: lastDispatchEvent,
              ...summarizePostMarkers(body),
            });
          }
          if (body.includes("RELEASED_OWNER_WORK")) {
            recoveryPosts.push(body);
          }
          if (body.includes("NEW_OWNER_WORK")) {
            successorPosts.push(body);
          }
          writeOpenAiResponsesText(response, {
            text: marker,
            messageId: "released-owner-message",
            responseId: "released-owner-response",
          });
        })();
        providerWork.add(work);
        void work
          .catch((error: unknown) => {
            providerErrors.push(error);
            if (!response.headersSent) {
              response.writeHead(500);
            }
            response.end();
          })
          .finally(() => providerWork.delete(work));
      });
      const entered = createDeferred<preparedRuntime.PreparedModelRuntimeLease>();
      const release = createDeferred();
      const recoveryScope = new AsyncLocalStorage<string>();
      const originalAcquire = preparedRuntime.acquireAgentRunPreparedModelRuntime;
      const originalRecover = restartRecovery.recoverInterruptedSubagentRow;
      let heldLease: preparedRuntime.PreparedModelRuntimeLease | undefined;
      let heldSignal: AbortSignal | undefined;
      let returnedLease: preparedRuntime.PreparedModelRuntimeLease | undefined;
      let recoveryWork: ReturnType<typeof originalRecover> | undefined;
      let dispatchWork: Promise<unknown> | undefined;
      let dispatchSettled = false;
      let recoveryStartOwner: AgentTurnStartOwner | undefined;
      let recoveryExecutionStarted = false;
      let runtime: GatewayRecoveryRuntime | undefined;
      let recoveryRunId: string | undefined;
      let terminalWork: Promise<{ status: string }> | undefined;
      let successorTerminal: Promise<{ status: string }> | undefined;
      let cancellation: ReturnType<typeof cancelTaskById> | undefined;
      let starting: ReturnType<typeof startGatewayWithClient> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let gatewayClosed = false;
      let workJoined = false;
      let providerClosed = false;
      let stateReleased = false;
      const restoreSpies: Array<() => void> = [];
      const joinDispatch = async (): Promise<{ status: string } | undefined> => {
        if (!dispatchWork) {
          return undefined;
        }
        const [dispatch] = await Promise.allSettled([dispatchWork]);
        if (
          dispatch.status === "fulfilled" &&
          dispatch.value !== null &&
          typeof dispatch.value === "object" &&
          "status" in dispatch.value &&
          (dispatch.value.status === "accepted" || dispatch.value.status === "in_flight") &&
          runtime &&
          recoveryRunId
        ) {
          terminalWork ??= runtime.waitForAgent<{ status: string }>(
            { runId: recoveryRunId, timeoutMs: 30_000 },
            35_000,
          );
          return await terminalWork;
        }
        return undefined;
      };

      await runQaGatewayFixture(
        async () => {
          state.applyEnv();
          resetSubagentRegistryForTests({ persist: false });
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
          await new Promise<void>((resolve, reject) => {
            provider.once("error", reject);
            provider.listen(0, "127.0.0.1", resolve);
          });
          const address = provider.address();
          if (!address || typeof address === "string") {
            throw new Error("released ownership provider did not bind");
          }
          const model = buildMockOpenAiResponsesProvider(
            `http://127.0.0.1:${address.port}/v1`,
            "gpt-released-owner",
          );
          const cfg = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                skipBootstrap: true,
                model: { primary: model.modelRef },
                models: {
                  [model.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
              },
              entries: { main: { default: true } },
            },
            models: { mode: "replace", providers: { [model.providerId]: model.config } },
            gateway: { auth: { mode: "token", token } },
            plugins: { slots: { memory: "none" } },
          } satisfies OpenClawConfig;
          await state.writeConfig(cfg);
          const now = Date.now();
          await writeSubagentSessionEntry({
            stateDir: state.stateDir,
            agentId: "main",
            sessionKey: "agent:main:main",
            defaultSessionId: "released-requester-session",
            updatedAt: now,
          });
          const storePath = await writeSubagentSessionEntry({
            stateDir: state.stateDir,
            agentId: "main",
            sessionKey: childSessionKey,
            sessionId,
            defaultSessionId: sessionId,
            lifecycleRevision,
            updatedAt: now,
            abortedLastRun: true,
          });
          // Returning tasks own mirrored flows. Neutral labels keep requester
          // completion prompts separate from the child-work POST markers.
          const released = writeReleasedCoreSubagentCandidateFixture(
            createSubagentRunRecord({
              runId,
              childSessionKey,
              task,
              label: "released ownership task",
              taskRunId: runId,
              generation: 1,
              createdAt: now - 60_000,
              startedAt: now - 55_000,
              spawnMode: "session",
              expectsCompletionMessage: true,
            }),
          );
          expectReleasedCoreSubagentCandidatePersisted(released);
          resetSubagentRegistryForTests({ persist: false });
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
          await cleanupSessionStateForTest({ stateDir: state.stateDir });
          if (mode === "cancelled") {
            // Native require cannot resolve this source-only control graph.
            // Inject the unchanged runtime through Vitest's module loader.
            setTaskRegistryControlRuntimeForTests(taskControlRuntime);
            restoreSpies.push(() => {
              if (workJoined && gatewayClosed) {
                resetTaskRegistryControlRuntimeForTests();
              }
            });
          }

          const acquireSpy = vi
            .spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime")
            .mockImplementation(async (...args) => {
              const lease = await originalAcquire(...args);
              if (
                recoveryScope.getStore() === runId &&
                args[0].agentId === "main" &&
                args[0].allowGatewaySubagentBinding === true &&
                !heldLease
              ) {
                // Delay the real producer result only. Production owns every
                // authority check, including the revalidation after this await.
                heldLease = lease;
                heldSignal = args[1]?.abortSignal;
                record("lease-held", "A");
                entered.resolve(lease);
                await release.promise;
                returnedLease = lease;
                record("lease-released", "A");
              }
              return lease;
            });
          restoreSpies.push(() => acquireSpy.mockRestore());
          const recoverySpy = vi
            .spyOn(restartRecovery, "recoverInterruptedSubagentRow")
            .mockImplementation((params) => {
              record("recovery", sourceOf(params.runId));
              if (!runtime && params.gatewayRuntime) {
                runtime = params.gatewayRuntime;
                const originalDispatch = runtime.dispatchAgent;
                const dispatchSpy = vi.spyOn(runtime, "dispatchAgent").mockImplementation(function <
                  T,
                >(...args: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>): Promise<T> {
                  const source = sourceOf(recoveryScope.getStore());
                  const captureRecovery =
                    !dispatchWork &&
                    source === "A" &&
                    args[0].sessionKey === childSessionKey &&
                    args[0].inputProvenance?.sourceTool === "subagent_interrupted_resume";
                  const options = args[2];
                  lastDispatchEvent = record("dispatch", source, {
                    target:
                      args[0].sessionKey === childSessionKey
                        ? "child"
                        : args[0].sessionKey === "agent:main:main"
                          ? "requester"
                          : "other",
                    guard: options?.assertAdmissionCurrent !== undefined,
                  });
                  const work = originalDispatch<T>(args[0], args[1], {
                    ...options,
                    onStartOwner: (owner) => {
                      record("start-owner", source);
                      if (captureRecovery) {
                        recoveryStartOwner = owner;
                      }
                      options?.onStartOwner?.(owner);
                    },
                    onExecutionStarted: () => {
                      record("execution", source);
                      if (captureRecovery) {
                        recoveryExecutionStarted = true;
                      }
                      options?.onExecutionStarted?.();
                    },
                  });
                  if (captureRecovery) {
                    recoveryRunId = args[0].idempotencyKey;
                    dispatchWork = work;
                  }
                  void work.then(
                    (value) => {
                      const status = asOptionalRecord(value)?.status;
                      record("settled", source, {
                        accepted: status === "accepted" || status === "in_flight",
                      });
                      if (captureRecovery) {
                        dispatchSettled = true;
                      }
                    },
                    () => {
                      record("rejected", source);
                      if (captureRecovery) {
                        dispatchSettled = true;
                      }
                    },
                  );
                  return work;
                });
                restoreSpies.push(() => dispatchSpy.mockRestore());
                const noticeSpy = vi.spyOn(runtime, "sendRecoveryNotice");
                restoreSpies.push(() => noticeSpy.mockRestore());
              }
              const work = recoveryScope.run(params.runId, () => originalRecover(params));
              if (params.runId === runId && !recoveryWork && runtime) {
                recoveryWork = work;
              }
              return work;
            });
          restoreSpies.push(() => recoverySpy.mockRestore());
          starting = startGatewayWithClient({
            cfg,
            configPath: state.configPath,
            token,
            clientDisplayName: "released-subagent-ownership",
          });
          void starting.catch(() => {});
          expect(await withTimeout(entered.promise, 30_000, "recovery preparation")).toBe(
            heldLease,
          );
          const predecessor = subagentRuns.get(runId);
          if (!predecessor) {
            throw new Error("Gateway did not hydrate the released predecessor");
          }
          expect(predecessor).not.toBe(released.run);
          expect(predecessor).toMatchObject({
            taskOwnershipPolicy: "core_required",
            requesterAgentId: "main",
            generation: 1,
          });
          expect(loadSubagentRegistryFromSqlite().get(runId)?.taskOwnershipPolicy).toBe(
            "core_required",
          );
          let protectedRows: ReturnType<typeof readDurableOwnership> | undefined;
          let protectedSession: ReturnType<typeof loadSessionEntry>;
          let successorTask: ReturnType<typeof findTaskByRunId>;
          if (!runtime || !heldSignal) {
            throw new Error("real recovery did not publish its Gateway admission");
          }
          checkpoints.aOwnerObserved = recoveryStartOwner !== undefined;
          checkpoints.aPreexecution = recoveryStartOwner?.observe()?.executionStarted === false;
          checkpoints.aCallbackUnseen = !recoveryExecutionStarted;
          checkpoints.aDispatchPending = dispatchWork !== undefined && !dispatchSettled;
          expect(checkpoints.aOwnerObserved).toBe(true);
          expect(checkpoints.aPreexecution).toBe(true);
          expect(checkpoints.aCallbackUnseen).toBe(true);
          expect(checkpoints.aDispatchPending).toBe(true);
          if (mode === "cancelled") {
            // The operator is outside recovery's admission context. Public cancel
            // interrupts first, then waits for this preparation before claiming.
            expect(recoveryScope.getStore()).toBeUndefined();
            const interrupted = createDeferred();
            const signal = heldSignal;
            const onInterrupt = () => interrupted.resolve();
            signal.addEventListener("abort", onInterrupt, { once: true });
            restoreSpies.push(() => signal.removeEventListener("abort", onInterrupt));
            cancellation = cancelTaskById({ cfg, taskId: released.task.taskId });
            await withTimeout(
              Promise.race([
                interrupted.promise,
                cancellation.then(
                  (result) => {
                    throw new Error(
                      `public cancellation settled before interruption: ${JSON.stringify({
                        outcome: "resolved",
                        found: result.found,
                        cancelled: result.cancelled,
                      })}`,
                    );
                  },
                  () => {
                    throw new Error("public cancellation rejected before interruption");
                  },
                ),
              ]),
              10_000,
              "public cancellation interruption",
            );
            expect(signal.aborted).toBe(true);
          } else if (mode !== "allowed") {
            expect(
              registerSubagentRun({
                runId: successorRunId,
                childSessionKey,
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "Complete NEW_OWNER_WORK.",
                label: "successor ownership task",
                cleanup: "keep",
                spawnMode: "session",
                queued: mode === "retained",
                expectsCompletionMessage: true,
                taskRowOwnership: "required",
              }),
            ).toBeDefined();
            expect(subagentRuns.get(successorRunId)?.generation).toBe(2);
            if (mode !== "retained") {
              await expect(
                runtime.dispatchAgent({
                  sessionKey: childSessionKey,
                  expectedExistingSessionId: sessionId,
                  idempotencyKey: successorRunId,
                  message: "Complete NEW_OWNER_WORK.",
                  deliver: false,
                  lane: "subagent",
                  inputProvenance: {
                    kind: "inter_session",
                    sourceSessionKey: "agent:main:main",
                    sourceChannel: "internal",
                    sourceTool: "sessions_spawn",
                  },
                }),
              ).resolves.toMatchObject({ status: "accepted", runId: successorRunId });
              successorTerminal = runtime.waitForAgent<{ status: string }>(
                { runId: successorRunId, timeoutMs: 30_000 },
                35_000,
              );
              await expect(successorTerminal).resolves.toMatchObject({ status: "ok" });
              checkpoints.bTerminal = true;
              await vi.waitFor(
                () => {
                  const successor = subagentRuns.get(successorRunId);
                  const successorSession = loadSessionEntry({
                    storePath,
                    sessionKey: childSessionKey,
                  });
                  checkpoints.bDelivered = successor?.delivery?.status === "delivered";
                  checkpoints.bTaskSucceeded =
                    findTaskByRunId(successorRunId)?.status === "succeeded";
                  checkpoints.bSessionDone = successorSession?.status === "done";
                  checkpoints.bLastRunMatches = successorSession?.lastRunId === successorRunId;
                  checkpoints.bLifecycleCleared = successorSession?.lifecycleRunId === undefined;
                  // A still owns a held Gateway root. Observe settled writer queues
                  // without the cleanup drain, which rejects pending writes.
                  checkpoints.bWritesSettled =
                    WRITER_QUEUES.size === 0 && SQLITE_SESSION_WRITER_QUEUES.size === 0;
                  expect(successor?.cleanupCompletedAt).toBeTypeOf("number");
                  expect(successor?.delivery?.status).toBe("delivered");
                  expect(findTaskByRunId(successorRunId)?.status).toBe("succeeded");
                  expect(successorSession).toMatchObject({
                    sessionId,
                    status: "done",
                    lastRunId: successorRunId,
                  });
                  expect(successorSession?.lifecycleRunId).toBeUndefined();
                  expect(checkpoints.bWritesSettled).toBe(true);
                },
                { timeout: 10_000 },
              );
              expect(successorPosts).toHaveLength(1);
              if (mode === "removed") {
                releaseSubagentRun(successorRunId);
                expect(loadSubagentRegistryFromSqlite().has(successorRunId)).toBe(false);
              }
            }
            successorTask = findTaskByRunId(successorRunId);
            expect(successorTask?.parentFlowId).toBeDefined();
            protectedRows = readDurableOwnership();
            protectedSession = structuredClone(
              loadSessionEntry({ storePath, sessionKey: childSessionKey }),
            );
            record("snapshot", "B");
          }
          release.resolve();
          gateway = await starting;
          await gateway.server.startupSettled;
          if (!recoveryWork || !dispatchWork || !recoveryRunId) {
            throw new Error("real recovery did not reach Gateway dispatch");
          }
          await recoveryWork;
          const terminal = await joinDispatch();
          if (cancellation) {
            await expect(cancellation).resolves.toMatchObject({ found: true, cancelled: true });
            expect(getTaskById(released.task.taskId)?.status).toBe("cancelled");
            expect(loadSubagentRegistryFromSqlite().get(runId)?.killReconciliation).toMatchObject({
              taskCancellationAccepted: true,
            });
          }
          if (mode === "allowed") {
            expect(terminal).toMatchObject({ status: "ok" });
            const recoveredRunId = recoveryRunId;
            await vi.waitFor(
              () => {
                const recovered = subagentRuns.get(recoveredRunId);
                expect(recovered?.cleanupCompletedAt).toBeTypeOf("number");
                expect(recovered?.delivery?.status).toBe("delivered");
                expect(getTaskById(released.task.taskId)?.status).toBe("succeeded");
              },
              { timeout: 10_000 },
            );
          }
          await settleSubagentRegistryPersistenceWork();
          expect(returnedLease).toBe(heldLease);
          expect(providerErrors).toEqual([]);
          if (mode === "allowed") {
            expect(recoveryPosts).toHaveLength(1);
            const runs = loadSubagentRegistryFromSqlite();
            expect(runs.has(runId)).toBe(false);
            expect(runs.get(recoveryRunId)).toMatchObject({
              generation: 2,
              taskRunId: runId,
              taskOwnershipPolicy: "core_required",
              delivery: { status: "delivered" },
            });
            expect(getTaskById(released.task.taskId)).toMatchObject({
              runId,
              detail: { runtime: "subagent", generation: 2 },
            });
            expect(readDurableOwnership().tasks).toHaveLength(1);
            expect(readDurableOwnership().flows).toHaveLength(1);
          } else {
            // An accepted dispatch must finish before zero POST can prove rejection.
            const [dispatch] = await Promise.allSettled([dispatchWork]);
            if (mode === "cancelled" && dispatch.status === "fulfilled") {
              expect(dispatch.value).toMatchObject({
                status: "timeout",
                summary: "aborted",
                providerStarted: false,
              });
            } else {
              expect(dispatch.status).toBe("rejected");
            }
            expect(recoveryPosts).toHaveLength(0);
            expect(runtime.sendRecoveryNotice).not.toHaveBeenCalled();
            expect(loadSubagentRegistryFromSqlite().has(recoveryRunId)).toBe(false);
            const after = readDurableOwnership();
            if (successorTask && protectedRows) {
              expect(after.tasks.find((row) => row.task_id === successorTask.taskId)).toEqual(
                protectedRows.tasks.find((row) => row.task_id === successorTask.taskId),
              );
              expect(after.flows.find((row) => row.flow_id === successorTask.parentFlowId)).toEqual(
                protectedRows.flows.find((row) => row.flow_id === successorTask.parentFlowId),
              );
              expect(after.runs.find((row) => row.run_id === successorRunId)).toEqual(
                protectedRows.runs.find((row) => row.run_id === successorRunId),
              );
              expect(after.tasks).toHaveLength(protectedRows.tasks.length);
              expect(after.flows).toHaveLength(protectedRows.flows.length);
              expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toEqual(
                protectedSession,
              );
            }
          }
        },
        async () => {
          release.resolve();
          if (starting) {
            gateway = await starting;
          }
        },
        () =>
          runQaGatewayFixture(
            async () => {
              await gateway?.server.startupSettled;
            },
            () => recoveryWork,
            () => joinDispatch(),
            () => successorTerminal,
            () => cancellation,
            () => {
              workJoined = true;
            },
          ),
        async () => {
          if (gateway) {
            await disconnectGatewayClient(gateway.client);
          }
        },
        async () => {
          if (gateway) {
            await gateway.server.close();
            gatewayClosed = true;
          } else {
            // Failed startup may retain an unreturned server. No handle means
            // no proof that its producers closed, so keep that fixture state.
            gatewayClosed = starting === undefined;
          }
        },
        () => runQaGatewayFixture(() => Promise.resolve(), ...restoreSpies.toReversed()),
        async () => {
          await Promise.allSettled(providerWork);
          if (provider.listening) {
            provider.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              provider.close((error) => (error ? reject(error) : resolve()));
            });
          }
          providerClosed = true;
        },
        async () => {
          if (gatewayClosed && workJoined && providerClosed) {
            await settleSubagentRegistryPersistenceWork();
            // This release drains writers/reconciles before closing databases.
            // A failed drain retains state instead of retiring live producers.
            await state.restoreEnv();
            stateReleased = true;
          }
        },
        () => {
          if (stateReleased) {
            resetSubagentRegistryForTests({ persist: false });
            resetTaskRegistryForTests({ persist: false });
            resetTaskFlowRegistryForTests({ persist: false });
          }
        },
        async () => {
          if (stateReleased) {
            await state.cleanup();
          }
        },
        // Restoring selectors does not close databases or remove retained state.
        () => environment.restore(),
      ).catch((error: unknown) => {
        emitFailureDiagnostic();
        throw error;
      });
    },
  );
});
