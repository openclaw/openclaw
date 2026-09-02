/** Pending native spawn must transfer only live invocation authority to the child owner. */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import {
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionDeleteHandlers } from "../../../gateway/server-methods/sessions-delete.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../../infra/agent-run-registry.js";
import { flushLogger, resetLogger } from "../../../logging/logger.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
} from "../../../sessions/session-lifecycle-admission.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import * as taskControlRuntime from "../../../tasks/task-registry-control.runtime.js";
import { cancelTaskById, findTaskByRunId, getTaskById } from "../../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqlite } from "../../../tasks/task-registry.store.sqlite.js";
import {
  resetTaskRegistryForTests,
  setTaskRegistryControlRuntimeForTests,
  resetTaskRegistryControlRuntimeForTests,
} from "../../../tasks/task-registry.test-support.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../admitted-run-context.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { codeModeSwarmHandlers } from "../../code-mode-swarm.runtime.js";
import { applyCodeModeCatalog, createCodeModeTools } from "../../code-mode.js";
import { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import { ToolSearchRuntime } from "../../tool-search-runtime.js";
import { createToolSearchCatalogRef, resolveToolSearchConfig } from "../../tool-search.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  markCollectorLaunchDispatching,
  markCollectorLaunchRunning,
  prepareCollectorRun,
  reserveCollectorRun,
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "../registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const parentSessionKey = "agent:main:main";
const parentRunId = "pending-spawn-parent";
const groupId = "pending-spawn";
const env = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
let stateDir = "";

beforeEach(async () => {
  stateDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-authority-")));
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  await writeFile(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      logging: { audit: { enabled: false } },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { workspace: stateDir }, entries: { main: { workspace: stateDir } } },
    }),
  );
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  // The source test supplies the real ESM owner through the existing CJS runtime seam.
  setTaskRegistryControlRuntimeForTests(taskControlRuntime);
  registryTesting.setDepsForTest({
    loadAgentRuntimePluginRegistryHandle: () => undefined,
    callGateway: async (request) => {
      if (request.method !== "agent.wait") {
        throw new Error(`Unexpected registry RPC ${request.method}`);
      }
      return await new Promise<never>(() => {});
    },
  });
});

afterEach(async () => {
  await settleSubagentRegistryPersistenceWork();
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  schedulerTesting.reset();
  resetTaskRegistryControlRuntimeForTests();
  await cleanupSessionStateForTest({ stateDir });
  registryTesting.setDepsForTest();
  spawnTesting.setDepsForTest();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await flushLogger();
  resetLogger();
  await rm(stateDir, { recursive: true, force: true });
  env.restore();
});

async function createBoundParent(runtime: "embedded" | "plugin-harness" = "embedded") {
  const cfg = getRuntimeConfig();
  const storePath = await writeSubagentSessionEntry({
    stateDir,
    agentId: "main",
    sessionKey: parentSessionKey,
    defaultSessionId: "parent-session",
  });
  const context = createChatAbortContext({
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
  });
  const admission = prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(parentRunId),
    facts: {
      runId: parentRunId,
      agentId: "main",
      ingress: { kind: "system", boundary: "spawn-authority-test", state: "present" },
    },
  });
  const parent = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
    runId: parentRunId,
    sessionKey: parentSessionKey,
    sessionId: "parent-session",
    agentId: "main",
    ownerConnId: "owner-connection",
    timeoutMs: 60_000,
    operationalRunInstance: admission.operationalRunInstance,
  });
  const admitted = await admission.admit(runtime);
  // Match agent-run-execution-phase: bind the admitted owner before tools run.
  bindGatewayContextResolver(admitted, () => context as unknown as GatewayRequestContext);
  const authority = getAdmittedRunDelegatedAuthority(admitted)!;
  parent.bindAgentRunDelegatedAuthority(authority);
  expect(parent.entry?.operationalRunInstance).toBe(admitted.operationalRunInstance);
  expect(parent.entry?.agentRunDelegatedAuthority).toBe(authority);
  expect(admitted.executionIdentityToken).toBeUndefined();

  return { cfg, storePath, context, admission, parent, admitted, authority };
}

describe("pending spawn invocation authority", () => {
  it.each([
    "native abort",
    "native acceptance",
    "native call signal",
    "native construction signal",
    "native claim loss",
    "native replacement",
    "native lifecycle rotation",
    "native admission close",
    "projected close",
    "projected claim loss",
  ])("rolls back an untransferred native spawn: %s", async (closure) => {
    const { cfg, storePath, context, admission, parent, admitted, authority } =
      await createBoundParent(closure.startsWith("projected") ? "plugin-harness" : "embedded");
    const acceptedGate = createDeferred();
    const acceptedEntered = createDeferred();
    let childController: ReturnType<typeof registerChatAbortController> | undefined;
    const entered = createDeferred<string>();
    const release = createDeferred();
    const rollback = vi.fn(async () => {});
    const agentDispatch = vi.fn();
    const deleted: string[] = [];
    spawnTesting.setDepsForTest({
      resolveContextEngine: async () =>
        Object.assign(new LegacyContextEngine(), {
          prepareSubagentSpawn: async ({ childSessionKey }: { childSessionKey: string }) => {
            entered.resolve(childSessionKey);
            await release.promise;
            return { rollback };
          },
        }),
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
        options?: {
          providerDispatchLifecycle?: {
            onDispatch: () => void;
            onAccepted: () => void;
          };
        },
      ) => {
        if (method === "agent") {
          options?.providerDispatchLifecycle?.onDispatch();
          agentDispatch(params);
          if (closure === "native acceptance") {
            const childSessionKey = params.sessionKey as string;
            const child = loadSessionEntry({ storePath, sessionKey: childSessionKey })!;
            childController = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId: params.idempotencyKey as string,
              sessionKey: childSessionKey,
              sessionId: child.sessionId,
              agentId: "main",
              timeoutMs: 60_000,
            });
            acceptedEntered.resolve();
            await acceptedGate.promise;
          }
          options?.providerDispatchLifecycle?.onAccepted();
          return { runId: params.idempotencyKey, status: "accepted" } as T;
        }
        if (method === "chat.abort") {
          const respond = await invokeChatAbortHandler({
            handler: handleChatAbortRequest,
            context,
            request: params as { sessionKey: string; runId: string },
            client: createSyntheticPluginRuntimeClient(),
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ aborted: true, runIds: [params.runId] }),
          );
          return respond.mock.calls[0]![1] as T;
        }
        if (method !== "sessions.delete") {
          throw new Error(`Unexpected spawn RPC ${method}`);
        }
        let payload: unknown;
        await sessionDeleteHandlers["sessions.delete"]!({
          req: {} as never,
          params,
          context: context as unknown as GatewayRequestContext,
          client: createSyntheticPluginRuntimeClient(),
          isWebchatConnect: () => false,
          respond: (ok, result, error) => {
            if (!ok) {
              throw new Error(error?.message ?? "delete failed");
            }
            payload = result;
          },
        });
        deleted.push(params.key as string);
        return payload as T;
      },
    });
    const invocationAbort = new AbortController();
    let replacementAuthority: ReturnType<typeof claimAgentRunDelegatedAuthority> | undefined;
    const host = closure.startsWith("projected")
      ? createAgentHarnessHostCapabilities({
          attempt: {
            admittedRunContext: admitted,
            runId: parentRunId,
            config: cfg,
            agentId: "main",
            sessionKey: parentSessionKey,
            abortSignal: parent.controller.signal,
          },
          pluginId: "test-harness",
        })
      : undefined;
    const source = createSessionsSpawnTool({
      config: cfg,
      agentSessionKey: parentSessionKey,
      requesterRunId: parentRunId,
      requesterTurnRunId: parentRunId,
      signal: closure === "native construction signal" ? invocationAbort.signal : undefined,
    });
    let forwarded: Promise<unknown> | undefined;
    const observed: AnyAgentTool = {
      ...source,
      execute: (...args) => {
        const pending = source.execute!(...args);
        // Observe, but still forward the real source promise through the native wrappers.
        forwarded = pending.then(
          (result) => result,
          (error: unknown) => error,
        );
        return pending;
      },
    };
    const [tool] = host
      ? host.capabilities.bindToolSurface([observed])
      : finalizeAgentTools({
          tools: [observed],
          hookContext: {
            config: cfg,
            agentId: "main",
            sessionKey: parentSessionKey,
            runId: parentRunId,
          },
          abortSignal: parent.controller.signal,
        });
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: parentSessionKey,
    });
    const wrapped = withPluginRuntimeGatewayRequestScope(
      { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
      () =>
        withGatewayToolCallerIdentity(caller, () =>
          tool!.execute!(
            "spawn-pending",
            {
              task: "bounded child",
              collect: closure !== "native acceptance",
              context: "isolated",
              groupId: closure === "native acceptance" ? undefined : groupId,
            },
            closure === "native call signal" ? invocationAbort.signal : undefined,
          ),
        ),
    );
    const wrappedOutcome = wrapped.then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      const childSessionKey = await Promise.race([
        entered.promise,
        wrappedOutcome.then((error) => {
          throw error;
        }),
      ]);
      expect([...subagentRuns.values()]).toEqual(
        closure === "native acceptance"
          ? []
          : [
              expect.objectContaining({
                childSessionKey,
                collectorLaunchPhase: "reserved",
              }),
            ],
      );
      expect([...loadSubagentRegistryFromSqlite().values()]).toEqual(
        closure === "native acceptance"
          ? []
          : [
              expect.objectContaining({
                childSessionKey,
                collectorLaunchPhase: "reserved",
              }),
            ],
      );
      expect(
        [...loadTaskRegistryStateFromSqlite().tasks.values()].some(
          (entry) => entry.runId === [...subagentRuns.keys()][0],
        ),
      ).toBe(false);
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeDefined();
      if (closure === "native acceptance") {
        release.resolve();
        await acceptedEntered.promise;
        expect(subagentRuns.size, "accepted local run still awaits source registration").toBe(0);
        expect(childController?.controller.signal.aborted).toBe(false);
      }
      if (closure === "native abort" || closure === "native acceptance") {
        const reply = await invokeChatAbortHandler({
          handler: handleChatAbortRequest,
          context,
          request: { sessionKey: parentSessionKey, runId: parentRunId },
          client: {
            connId: "owner-connection",
            connect: { scopes: ["operator.read", "operator.write"] },
          },
        });
        expect(reply).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [parentRunId],
        });
        expect(parent.controller.signal.aborted).toBe(true);
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        expect(await wrappedOutcome).toBeInstanceOf(Error);
      } else {
        if (closure.endsWith("claim loss")) {
          releaseAgentRunDelegatedAuthority(authority);
        } else if (closure.endsWith("replacement")) {
          replacementAuthority = claimAgentRunDelegatedAuthority(
            createOperationalRunInstanceRef(parentRunId),
          );
        } else if (closure.endsWith("lifecycle rotation")) {
          rotateAgentRunRegistryLifecycleGeneration();
        } else if (closure === "projected close") {
          host!.close();
        } else if (closure.endsWith("signal")) {
          invocationAbort.abort();
        } else {
          admission.close();
        }
        expect(
          parent.controller.signal.aborted,
          "claim/capability closure is independent of parent signal",
        ).toBe(false);
      }
      release.resolve();
      acceptedGate.resolve();
      await forwarded;
      if (closure === "native acceptance") {
        expect(agentDispatch).toHaveBeenCalledOnce();
        expect(
          childController?.controller.signal.aborted,
          "exact accepted local child aborted before deletion",
        ).toBe(true);
        expect(subagentRuns.size).toBe(0);
      } else {
        expect(agentDispatch, "cancelled source never dispatches a child").not.toHaveBeenCalled();
        expect([...subagentRuns.values()]).toEqual([
          expect.objectContaining({
            childSessionKey,
            execution: expect.objectContaining({ status: "terminal" }),
            collectorCompletion: expect.objectContaining({
              status: closure === "native abort" ? "killed" : "failed",
            }),
          }),
        ]);
      }
      expect(rollback).toHaveBeenCalledOnce();
      expect(deleted).toEqual([childSessionKey]);
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeUndefined();
      const survivor = vi.fn(async () => {});
      enqueueSwarmRun({
        groupId: JSON.stringify([parentSessionKey, groupId]),
        runId: "surviving-reservation",
        maxConcurrent: 1,
        activeRunIds: [],
        start: survivor,
        onStartFailure: () => true,
      });
      await vi.waitFor(() => expect(survivor).toHaveBeenCalledOnce());
    } finally {
      release.resolve();
      acceptedGate.resolve();
      await forwarded;
      childController?.cleanup();
      await wrappedOutcome;
      host?.close();
      if (replacementAuthority) {
        releaseAgentRunDelegatedAuthority(replacementAuthority);
      }
      admission.close();
      parent.cleanup();
    }
  });

  it.each(["complete", "abort", "abort during registration"])(
    "preserves child ownership when the parent closes after registration: %s",
    async (closure) => {
      const { cfg, context, admission, parent, admitted } = await createBoundParent();
      const blockerStarted = createDeferred();
      enqueueSwarmRun({
        groupId: JSON.stringify([parentSessionKey, groupId]),
        runId: "handoff-blocker",
        maxConcurrent: 1,
        activeRunIds: [],
        start: async () => {
          blockerStarted.resolve();
        },
        onStartFailure: () => true,
      });
      await blockerStarted.promise;
      let cancellation: ReturnType<typeof invokeChatAbortHandler> | undefined;
      const abortParent = () =>
        invokeChatAbortHandler({
          handler: handleChatAbortRequest,
          context,
          request: { sessionKey: parentSessionKey, runId: parentRunId },
          client: {
            connId: "owner-connection",
            connect: { scopes: ["operator.read", "operator.write"] },
          },
        });
      if (closure === "abort during registration") {
        configureTaskRegistryRuntime({
          observers: {
            onEvent: (event) => {
              if (event.kind === "upserted" && event.task.runtime === "subagent" && !cancellation) {
                cancellation = abortParent();
              }
            },
          },
        });
      }
      const rollback = vi.fn(async () => {});
      const dispatch = vi.fn();
      spawnTesting.setDepsForTest({
        resolveContextEngine: async () =>
          Object.assign(new LegacyContextEngine(), {
            prepareSubagentSpawn: async () => ({ rollback }),
          }),
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
          options?: {
            providerDispatchLifecycle?: {
              onDispatch: () => void;
              onAccepted: () => void;
            };
          },
        ) => {
          expect(method).toBe("agent");
          options?.providerDispatchLifecycle?.onDispatch();
          dispatch(params.idempotencyKey);
          options?.providerDispatchLifecycle?.onAccepted();
          return { runId: params.idempotencyKey, status: "accepted" } as T;
        },
      });
      const source = createSessionsSpawnTool({
        config: cfg,
        agentSessionKey: parentSessionKey,
        requesterRunId: parentRunId,
        requesterTurnRunId: parentRunId,
      });
      let forwarded: Promise<unknown> | undefined;
      const observed: AnyAgentTool = {
        ...source,
        execute: (...args) => {
          const pending = source.execute!(...args);
          forwarded = pending.then(
            (value) => value,
            (error: unknown) => error,
          );
          return pending;
        },
      };
      const [tool] = finalizeAgentTools({
        tools: [observed],
        hookContext: {
          config: cfg,
          agentId: "main",
          sessionKey: parentSessionKey,
          runId: parentRunId,
        },
        abortSignal: parent.controller.signal,
      });
      const pending = withPluginRuntimeGatewayRequestScope(
        { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey: parentSessionKey,
            }),
            () =>
              tool!.execute!("spawn-handoff", {
                task: "independent after handoff",
                collect: true,
                context: "isolated",
                groupId,
              }),
          ),
      ).then(
        (value) => value,
        (error: unknown) => error,
      );
      try {
        const sourceResult = await pending;
        // The source can finish its handoff even when the outer native wrapper is aborted.
        const accepted = await forwarded;
        expect(accepted).toMatchObject({ details: { status: "accepted" } });
        const { runId } = (accepted as { details: { runId: string } }).details;
        expect(subagentRuns.get(runId)?.requesterTurnRunId).toBe(parentRunId);
        expect(dispatch).not.toHaveBeenCalled();
        if (closure !== "complete") {
          cancellation ??= abortParent();
          const respond = await cancellation;
          expect(respond).toHaveBeenCalledWith(true, {
            ok: true,
            aborted: true,
            runIds: [parentRunId],
          });
        } else {
          expect(sourceResult).toMatchObject({ details: { status: "accepted", runId } });
          expect(subagentRuns.get(runId)?.execution.status).toBe("queued");
          expect(findTaskByRunId(runId)?.status).toBe("queued");
          admission.close();
          parent.cleanup();
          expect(parent.controller.signal.aborted).toBe(false);
        }
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        // Capacity is released by Gateway-owned work, outside the completed parent's caller.
        withPluginRuntimeGatewayRequestScope(
          { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
          () => releaseSwarmRun("handoff-blocker"),
        );
        if (closure !== "complete") {
          expect(dispatch).not.toHaveBeenCalled();
          expect(findTaskByRunId(runId)?.status).toBe("cancelled");
          expect(subagentRuns.get(runId)).toMatchObject({
            collectorCompletion: { status: "killed" },
          });
        } else {
          expect(sourceResult).toMatchObject({ details: { status: "accepted", runId } });
          await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith(runId));
          expect(rollback).not.toHaveBeenCalled();
          expect(subagentRuns.get(runId)).toMatchObject({ execution: { status: "running" } });
        }
      } finally {
        configureTaskRegistryRuntime({ observers: null });
        releaseSwarmRun("handoff-blocker");
        await cancellation;
        await forwarded;
        await pending;
        admission.close();
        parent.cleanup();
      }
    },
  );

  it("keeps deterministic collector identity through delayed provider acceptance", async () => {
    const { cfg, storePath, context, admission, parent } = await createBoundParent();
    const response = createDeferred();
    const dispatchEntered = createDeferred();
    spawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        _params: Record<string, unknown>,
        options?: {
          providerDispatchLifecycle?: {
            onDispatch: () => void;
            onAccepted: () => void;
          };
        },
      ) => {
        expect(method).toBe("agent");
        options?.providerDispatchLifecycle?.onDispatch();
        dispatchEntered.resolve();
        await response.promise;
        options?.providerDispatchLifecycle?.onAccepted();
        return { runId: "accepted-task-run", status: "accepted" } as T;
      },
    });
    let lease: ReturnType<typeof consumeSessionWorkAdmissionHandoff>;
    let cancellation: ReturnType<typeof cancelTaskById> | undefined;
    try {
      const spawned = await withPluginRuntimeGatewayRequestScope(
        { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
        () =>
          spawnSubagentDirect(
            {
              task: "acceptance rekey",
              collect: true,
              context: "isolated",
              lightContext: true,
              groupId,
            },
            { agentSessionKey: parentSessionKey, requesterRunId: parentRunId },
          ),
      );
      expect(spawned.status).toBe("accepted");
      await dispatchEntered.promise;
      const entry = subagentRuns.get(spawned.runId!)!;
      const task = findTaskByRunId(spawned.runId!)!;
      expect(task).toMatchObject({ runId: spawned.runId, runtime: "subagent", status: "queued" });
      const child = loadSessionEntry({ storePath, sessionKey: spawned.childSessionKey! })!;
      const identities = [spawned.childSessionKey!, child.sessionId];
      const work = await beginSessionWorkAdmission({
        scope: storePath,
        identities,
        assertAllowed: () => {},
      });
      const interrupted = createDeferred();
      lease = consumeSessionWorkAdmissionHandoff({
        scope: storePath,
        identities,
        handoffId: work.createHandoff(),
        onInterrupt: () => interrupted.resolve(),
      });
      const generation = entry.generation;
      const createdAt = entry.createdAt;
      const taskRunId = entry.taskRunId;
      const schedulerSlotId = entry.schedulerSlotId;
      cancellation = cancelTaskById({ cfg, taskId: task.taskId });
      await Promise.race([
        interrupted.promise,
        cancellation.then((result) => {
          throw new Error(`Cancellation returned before drain: ${JSON.stringify(result)}`);
        }),
      ]);
      response.resolve();
      await vi.waitFor(() =>
        expect(subagentRuns.get(spawned.runId!)).toMatchObject({
          collectorLaunchPhase: "running",
        }),
      );
      expect(subagentRuns.has("accepted-task-run")).toBe(false);
      expect(entry).toMatchObject({ generation, createdAt, taskRunId, schedulerSlotId });
      lease?.release();
      const result = await cancellation;
      expect(result).toMatchObject({ found: true, cancelled: true });
      expect(getTaskById(task.taskId)).toMatchObject({ status: "cancelled" });
    } finally {
      response.resolve();
      lease?.release();
      await cancellation;
      admission.close();
      parent.cleanup();
    }
  });

  it("serializes competing replay reservations before session or provider side effects", async () => {
    const runId = "cm_replay_competing:bridge:agentSpawn:1";
    const childSessionKey = `agent:main:subagent:${runId}`;
    const registration = {
      runId,
      childSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      requesterAgentId: "main",
      agentId: "main",
      task: "bounded replay",
      cleanup: "keep" as const,
      collect: true,
      swarmRequesterSessionKey: parentSessionKey,
      swarmLaunchIdempotencyKey: runId,
      swarmLaunchReplayKey: runId,
      swarmLaunchRequestFingerprint: "sha256:matching",
      groupId,
    };

    const reservations = await Promise.all([
      Promise.resolve().then(() => reserveCollectorRun(registration)),
      Promise.resolve().then(() => reserveCollectorRun(registration)),
    ]);

    expect(
      reservations
        .map((entry) => entry.created)
        .toSorted((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(reservations[0]?.runId).toBe(reservations[1]?.runId);
    expect(loadSubagentRegistryFromSqlite().size).toBe(1);
    expect(loadTaskRegistryStateFromSqlite().tasks.size).toBe(0);
    expect(() =>
      reserveCollectorRun({
        ...registration,
        swarmLaunchRequestFingerprint: "sha256:different",
      }),
    ).toThrow("collector replay key was reused with a different request");
  });

  it("persists the real agents.run bridge through sessions_spawn into matching SQLite rows", async () => {
    const { cfg, context, admission, parent, admitted } = await createBoundParent();
    const providerDispatch = vi.fn();
    spawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
        options?: {
          providerDispatchLifecycle?: {
            onDispatch: () => void;
            onAccepted: () => void;
          };
        },
      ) => {
        expect(method).toBe("agent");
        options?.providerDispatchLifecycle?.onDispatch();
        providerDispatch(params);
        options?.providerDispatchLifecycle?.onAccepted();
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });
    const source = createSessionsSpawnTool({
      config: cfg,
      agentSessionKey: parentSessionKey,
      requesterRunId: parentRunId,
      requesterTurnRunId: parentRunId,
    });
    const [tool] = finalizeAgentTools({
      tools: [source],
      hookContext: {
        config: cfg,
        agentId: "main",
        sessionKey: parentSessionKey,
        runId: parentRunId,
      },
      abortSignal: parent.controller.signal,
    });
    const catalogRef = createToolSearchCatalogRef();
    const bridgeContext = {
      config: cfg,
      runtimeConfig: cfg,
      sessionKey: parentSessionKey,
      agentId: "main",
      runId: parentRunId,
      catalogRef,
    };
    applyCodeModeCatalog({
      tools: [...createCodeModeTools(bridgeContext), tool!],
      config: cfg,
      sessionId: "parent-session",
      sessionKey: parentSessionKey,
      agentId: "main",
      runId: parentRunId,
      catalogRef,
    });
    const runtime = new ToolSearchRuntime(bridgeContext, resolveToolSearchConfig(cfg));
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: parentSessionKey,
    });
    const invoke = (task: string) =>
      withPluginRuntimeGatewayRequestScope(
        { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(caller, () =>
            codeModeSwarmHandlers.agentSpawn({
              runtime,
              parentToolCallId: "code-mode-integration",
              request: {
                id: "bridge:agentSpawn:1",
                method: "agentSpawn",
                args: [task],
              },
              codeModeRunId: "cm_replay_integration",
              ctx: bridgeContext,
            }),
          ),
      );

    try {
      const spawned = await invoke("bounded integration");
      await vi.waitFor(() => expect(providerDispatch).toHaveBeenCalledOnce());
      const runId = (spawned as { runId: string }).runId;
      const persisted = loadSubagentRegistryFromSqlite().get(runId);
      expect(persisted).toMatchObject({
        runId,
        childSessionKey: `agent:main:subagent:${runId}`,
        collectorLaunchPhase: "running",
        execution: { status: "running" },
        swarmLaunchReplayKey: "cm_replay_integration:bridge:agentSpawn:1",
        swarmLaunchRequestFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      expect(
        [...loadTaskRegistryStateFromSqlite().tasks.values()].find(
          (entry) => entry.runId === runId,
        ),
      ).toMatchObject({ sourceId: runId, status: "running" });
      await expect(invoke("bounded integration")).resolves.toMatchObject({ runId });
      await expect(invoke("different request")).rejects.toThrow(
        "agents.run replay request does not match the persisted collector",
      );
      expect(providerDispatch).toHaveBeenCalledOnce();
    } finally {
      admission.close();
      parent.cleanup();
    }
  });

  it.each(["reserved", "prepared", "dispatching", "running"] as const)(
    "recovers a %s collector with matching provider and task state",
    async (phase) => {
      const runId = `restart-${phase}`;
      const childSessionKey = `agent:main:subagent:${runId}`;
      const registration = {
        runId,
        childSessionKey,
        requesterSessionKey: parentSessionKey,
        requesterDisplayKey: parentSessionKey,
        requesterAgentId: "main",
        agentId: "main",
        task: `restart ${phase}`,
        cleanup: "keep" as const,
        collect: true,
        queued: true,
        swarmRequesterSessionKey: parentSessionKey,
        swarmLaunchIdempotencyKey: runId,
        swarmLaunchReplayKey: runId,
        swarmLaunchRequestFingerprint: `sha256:${phase}`,
        groupId,
        queuedLaunch: {
          request: {
            idempotencyKey: runId,
            sessionKey: childSessionKey,
            message: `restart ${phase}`,
          },
          timeoutMs: 1_000,
          schedulerGroupKey: groupId,
          maxConcurrent: 1,
        },
      };
      const reservation = reserveCollectorRun(registration);
      if (phase !== "reserved") {
        await writeSubagentSessionEntry({
          stateDir,
          agentId: "main",
          sessionKey: childSessionKey,
          defaultSessionId: `session-${phase}`,
        });
        prepareCollectorRun(reservation, registration);
      }
      if (phase === "dispatching" || phase === "running") {
        expect(markCollectorLaunchDispatching(runId)).toBe(true);
      }
      if (phase === "running") {
        expect(markCollectorLaunchRunning(runId)).toBe(true);
      }

      const dispatchAgent = vi.fn(
        async (
          _params: Record<string, unknown>,
          _timeoutMs?: number,
          options?: {
            providerDispatchLifecycle?: {
              onDispatch: () => void;
              onAccepted: () => void;
            };
          },
        ) => {
          options?.providerDispatchLifecycle?.onDispatch();
          options?.providerDispatchLifecycle?.onAccepted();
          return { status: "accepted", runId };
        },
      );
      resetSubagentRegistryForTests({ persist: false });
      schedulerTesting.reset();
      initSubagentRegistry();
      const recoveryContext = {
        recoveryRuntime: {
          dispatchAgent,
          waitForAgent: async () => await new Promise<never>(() => {}),
        },
        resolveGatewayContext: () => recoveryContext,
      };
      activateSubagentRegistry(() => recoveryContext as never);

      if (phase === "prepared") {
        await vi.waitFor(() =>
          expect({
            dispatches: dispatchAgent.mock.calls.length,
            run: loadSubagentRegistryFromSqlite().get(runId),
            task: findTaskByRunId(runId),
          }).toMatchObject({
            dispatches: 1,
            run: { collectorLaunchPhase: "running" },
            task: { status: "running" },
          }),
        );
        expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
          collectorLaunchPhase: "running",
          execution: { status: "running" },
        });
        expect(findTaskByRunId(runId)).toMatchObject({ status: "running" });
      } else {
        if (phase === "reserved") {
          await vi.waitFor(() => expect(loadSubagentRegistryFromSqlite().has(runId)).toBe(false));
        } else {
          await vi.waitFor(() =>
            expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
              execution: { status: "terminal" },
            }),
          );
        }
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(findTaskByRunId(runId)?.status).toBe(phase === "reserved" ? undefined : "lost");
      }
    },
  );
});
