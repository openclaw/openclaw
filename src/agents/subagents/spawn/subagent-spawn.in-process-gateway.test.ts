import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { createExecutionIdentityAdmissionToken } from "../../../audit/execution-identity-admission.js";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "../../../config/config.js";
import { captureSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import { readAgentRuntimeExecutionLineage } from "../../../gateway/agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentity } from "../../../gateway/agent-runtime-identity-token.js";
import { readInProcessAgentRuntimeIdentity } from "../../../gateway/in-process-agent-runtime-identity.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { GatewayRequestOptions } from "../../../gateway/server-methods/types.js";
import type { WorkerSessionTurnClaim } from "../../../gateway/worker-environments/placement-record.js";
import type {
  WorkerTurnExecutionIdentity,
  WorkerTurnExecutionIdentityCapability,
} from "../../../gateway/worker-environments/placement-turn-claim-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { listSessionStateEventsSince } from "../../../sessions/session-state-events.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { createOperationalRunInstanceRef } from "../../admitted-run-context.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import {
  configureMockSubagentRegistryPersistence,
  type MockSubagentRegistryRows,
} from "../../subagent-test-fixtures.test-helpers.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "../registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { observeRootWork } from "../registry/subagent-registry.browser-cleanup.test-support.js";
import { markSubagentRunTerminated } from "../registry/subagent-registry.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { withParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import "./subagent-spawn-model.mocks.shared.js";
import { makeGatewayContext } from "./subagent-spawn.in-process-gateway.test-support.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagent-spawn.test-support.js";

vi.mock("../../runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle:
    vi.fn<typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>(),
}));
vi.mock("../registry/subagent-registry-state.js", { spy: true });
vi.mock("../registry/subagent-registry-persistence.js", { spy: true });

const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
let stateDir = "";
const persistRegistryRows = vi.fn<MockSubagentRegistryRows>();

function inGateway<T>(run: () => T, context = makeGatewayContext()) {
  return withPluginRuntimeGatewayRequestScope(
    { context, client: externalCliClient(), isWebchatConnect: () => false },
    run,
  );
}

function collector(task: string, groupId: string, replay: string) {
  return spawnSubagentDirect(
    {
      task,
      collect: true,
      context: "isolated",
      lightContext: true,
      groupId,
      swarmLaunchReplayKey: `code-mode:agentSpawn:${replay}`,
    },
    { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
  );
}

function parentAuthority() {
  const parentToken = createExecutionIdentityAdmissionToken("parent-run", {
    contextId: "parent-context",
    executionId: "parent-execution",
  });
  const operationalRunInstance = createOperationalRunInstanceRef("parent-run");
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  return { parentToken, operationalRunInstance, authority };
}

function captureChildIdentity() {
  let identity: AgentRuntimeIdentity | undefined;
  subagentSpawnTesting.setDepsForTest({
    dispatchGatewayMethodInProcess: async <T>(_method, params, options) => {
      identity = readInProcessAgentRuntimeIdentity(options);
      return { runId: params.idempotencyKey, status: "accepted" } as T;
    },
  });
  return () => identity;
}

function externalCliClient(): GatewayRequestOptions["client"] {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      scopes: ["operator.write"],
    },
  } as GatewayRequestOptions["client"];
}

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  let lastError: unknown;
  for (let elapsed = 0; elapsed <= timeoutMs; elapsed += 10) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw lastError;
}

async function waitForTerminal(runId: string, signal: AbortSignal) {
  const terminal = createDeferredCore();
  const inspect = () => {
    if (subagentRuns.get(runId)?.execution.status === "terminal") {
      terminal.resolve();
    }
  };
  const stop = subscribeSubagentRunChanges("projection", inspect);
  try {
    inspect();
    await withinTest(terminal.promise, signal);
  } finally {
    stop();
  }
}

describe("spawnSubagentDirect in-process Gateway collector launch", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    await resetSubagentRegistryForTests({ persist: false });
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(createTestRegistry([]));
    persistRegistryRows.mockReset();
    await configureMockSubagentRegistryPersistence({ persistRegistryRows });
    vi.mocked(restoreSubagentRunsFromDisk).mockResolvedValue(0);

    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-swarm-gateway-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify({
        logging: { audit: { enabled: true, executionIdentity: true } },
        session: { mainKey: "main", scope: "per-sender" },
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
        agents: {
          defaults: { workspace: stateDir },
          entries: { main: { workspace: stateDir } },
        },
      })}\n`,
    );
    clearConfigCache();
    await captureRuntimeConfigAsyncReader()();
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    await resetSubagentRegistryForTests({ persist: false });
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    persistRegistryRows.mockReset();
    vi.mocked(restoreSubagentRunsFromDisk).mockReset();
    subagentSpawnTesting.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await cleanupSessionStateForTest({ stateDir });
    envSnapshot.restore();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  it("launches queued collectors after the parent admission lease is released", async ({
    signal,
  }) => {
    const gatewayContext = makeGatewayContext();
    const firstLaunchGate = createDeferredCore();
    const dispatches = [createDeferredCore(), createDeferredCore()];
    const waitEntries = [createDeferredCore(), createDeferredCore()];
    const terminalReplies = [createDeferredCore(), createDeferredCore()];
    const launchedRunIds: string[] = [];
    const subordinateAdmissionStates: boolean[] = [];
    let launchCount = 0;
    gatewayContext.recoveryRuntime = {
      prepareRestartRecovery: () => undefined,
      waitForAgent: async <T>(params: { runId: string }): Promise<T> => {
        const index = launchedRunIds.indexOf(params.runId);
        const terminal = expectDefined(terminalReplies[index], "launched collector terminal owner");
        const startedAt = Date.now();
        expectDefined(waitEntries[index], "launched collector wait owner").resolve();
        await terminal.promise;
        return {
          status: "ok",
          startedAt,
          endedAt: Date.now(),
          terminalReply: { disposition: "visible", text: "collector finished" },
        } as T;
      },
      dispatchAgent: async () => {
        throw new Error("Unexpected fixture recovery agent dispatch");
      },
      dispatchSessionMethod: async (method) => {
        throw new Error(`Unexpected fixture recovery session method ${method}`);
      },
      sendRecoveryNotice: async () => {
        throw new Error("Unexpected fixture recovery notice");
      },
    } satisfies GatewayRecoveryRuntime;
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(method, params) => {
        expect(method).toBe("agent");
        subordinateAdmissionStates.push(isGatewaySubordinateWorkAdmissionClosed());
        launchedRunIds.push(String(params.idempotencyKey));
        launchCount += 1;
        expectDefined(dispatches[launchCount - 1], "expected collector dispatch").resolve();
        if (launchCount === 1) {
          await firstLaunchGate.promise;
        }
        return { runId: params.idempotencyKey as string, status: "accepted" } as T;
      },
    });

    const parentAdmission = tryBeginGatewayRootWorkAdmission();
    const settleRootWork = observeRootWork();
    let spawnedWork: ReturnType<typeof spawnSubagentDirect>[] = [];
    let spawning: Promise<Awaited<ReturnType<typeof spawnSubagentDirect>>[]> | undefined;
    try {
      expect(parentAdmission).not.toBeNull();
      spawning = parentAdmission!.run(() =>
        inGateway(() => {
          spawnedWork = [
            collector("first collector", "swarm-queued-launch", "1"),
            collector("second collector", "swarm-queued-launch", "2"),
          ];
          return Promise.all(spawnedWork);
        }, gatewayContext),
      );
      const results = await withinTest(spawning, signal);
      parentAdmission!.release();

      expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"]);
      await withinTest(dispatches[0]!.promise, signal);
      expect(launchCount).toBe(1);
      firstLaunchGate.resolve();
      await withinTest(waitEntries[0]!.promise, signal);
      expect(launchCount).toBe(1);
      const queued = expectDefined(
        results.find((result) => result.runId !== launchedRunIds[0]),
        "queued collector",
      );
      expect(subagentRuns.get(queued.runId!)).toMatchObject({
        execution: { status: "queued" },
        swarmLaunchPending: true,
      });
      terminalReplies[0]!.resolve();
      await withinTest(Promise.all([dispatches[1]!.promise, waitEntries[1]!.promise]), signal);
      expect(launchCount).toBe(2);
      expect(subagentRuns.get(launchedRunIds[0]!)).toMatchObject({
        execution: { status: "terminal", outcome: { status: "ok" } },
      });
      for (const result of results) {
        expect(subagentRuns.get(result.runId!)).toMatchObject({
          collect: true,
          swarmLaunchPending: false,
        });
      }
      expect(subordinateAdmissionStates).toEqual([false, false]);
    } finally {
      firstLaunchGate.resolve();
      terminalReplies.forEach((reply) => reply.resolve());
      parentAdmission?.release();
      try {
        await Promise.allSettled(spawnedWork);
        const results = await spawning;
        await withinTest(
          Promise.all(
            (results ?? []).flatMap((result) =>
              result.status === "accepted" && result.runId
                ? [waitForTerminal(result.runId, signal)]
                : [],
            ),
          ),
          signal,
        );
      } finally {
        await settleRootWork();
      }
    }
  });

  it("gives each selected global agent its own collector capacity", async () => {
    await writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        session: { scope: "global" },
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
        agents: {
          ownership: "explicit",
          defaults: { workspace: stateDir },
          entries: {
            main: { workspace: stateDir },
            worker: { workspace: stateDir },
          },
        },
      }),
    );
    clearConfigCache();
    const launched: string[] = [];
    const launchGate = createDeferredCore();
    subagentSpawnTesting.setDepsForTest({
      dispatchGatewayMethodInProcess: async <T>(method, params) => {
        if (method === "agent") {
          launched.push(params.sessionKey as string);
          await launchGate.promise;
        }
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });
    const results = await inGateway(() =>
      Promise.all(
        ["main", "worker"].map((requesterAgentIdOverride) =>
          spawnSubagentDirect(
            {
              task: "collect independently",
              collect: true,
              context: "isolated",
              lightContext: true,
              groupId: "shared",
            },
            {
              agentSessionKey: "global",
              requesterAgentIdOverride,
              requesterRunId: `parent-${requesterAgentIdOverride}`,
            },
          ),
        ),
      ),
    );
    try {
      expect(results).toMatchObject([{ status: "accepted" }, { status: "accepted" }]);
      await waitForAssertion(() =>
        expect(launched.toSorted()).toEqual(
          results
            .map((result) => expectDefined(result.childSessionKey, "accepted child session key"))
            .toSorted(),
        ),
      );
    } finally {
      launchGate.resolve();
      await waitForAssertion(() =>
        expect(subagentRuns.get(results[0]!.runId!)?.swarmLaunchPending).toBe(false),
      );
    }
  });

  it.each(["native", "worker"] as const)(
    "carries and revalidates the %s parent identity",
    async (kind) => {
      const { parentToken, operationalRunInstance, authority } = parentAuthority();
      const caller = {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        executionIdentityToken: parentToken,
        receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
      };
      let validations = 0;
      let capability: WorkerTurnExecutionIdentityCapability | undefined;
      let turnClaim: WorkerSessionTurnClaim | undefined;
      if (kind === "worker") {
        turnClaim = {
          sessionId: "parent-session-id",
          runId: "parent-run",
          claimId: "parent-claim",
          placementGeneration: 4,
          owner: { kind: "worker", environmentId: "worker-env", ownerEpoch: 7 },
        };
        const identity: WorkerTurnExecutionIdentity = {
          ...caller,
          delegatedAuthority: authority,
          receiptAuthority: () => {
            if (!validateAgentRunDelegatedAuthority(authority)) {
              throw new Error("worker execution authority is no longer active");
            }
          },
          sessionTarget: captureSessionTranscriptTargetBinding({
            agentId: "main",
            sessionId: turnClaim.sessionId,
            sessionKey: caller.sessionKey,
            storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
          }),
          turnClaim,
        };
        capability = {
          sessionTarget: identity.sessionTarget,
          receiptAuthority: identity.receiptAuthority,
          async run<T>(callback: (current: WorkerTurnExecutionIdentity) => Promise<T> | T) {
            validations += 1;
            return await callback(identity);
          },
        };
      }
      const childIdentity = captureChildIdentity();
      const dispatch = (
        current: NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>,
        task: string,
      ) =>
        withGatewayToolCallerIdentity(current, () =>
          spawnSubagentDirect(
            { task, context: "isolated", lightContext: true },
            withParentExecutionIdentity(
              { agentSessionKey: current.sessionKey },
              current.executionIdentityToken,
            ),
          ),
        );
      try {
        const result = await inGateway(() =>
          capability
            ? capability.run((current) =>
                dispatch(
                  {
                    ...current,
                    workerTurnClaim: current.turnClaim,
                    workerTurnExecutionIdentityCapability: capability,
                  },
                  "inspect worker lineage",
                ),
              )
            : dispatch(caller, "inspect lineage"),
        );
        expect(result.status).toBe("accepted");
        if (kind === "worker") {
          expect(validations).toBe(2);
          expect(childIdentity()?.delegatedAuthority).toMatchObject({ kind: "worker", turnClaim });
        } else {
          expect(result.error).toBeUndefined();
          const childSessionKey = expectDefined(result.childSessionKey, "accepted child session");
          const events = (await listSessionStateEventsSince(childSessionKey, "main", 0)).events;
          expect(events.map((event) => event.kind)).toEqual(["created", "child_spawned"]);
          const spawned = expectDefined(events[1], "spawned signal");
          expect(spawned).toMatchObject({ actorId: "agent:main:main", runId: result.runId });
          expect(
            openOpenClawStateDatabase()
              .db.prepare(
                `SELECT last_seen_sequence, notified_sequence, material_sequence
           FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?`,
              )
              .get("agent:main:main", childSessionKey),
          ).toEqual({
            last_seen_sequence: spawned.sequence,
            notified_sequence: spawned.sequence,
            material_sequence: spawned.sequence,
          });
          expect(childIdentity()?.executionIdentity).toBe(parentToken);
          expect(
            readAgentRuntimeExecutionLineage(childIdentity()?.sessionSpawnContext),
          ).toMatchObject({
            relation: "sessions_spawn",
            requesterRef: "agent:main:main",
            controllerRef: "agent:main:main",
            depth: 1,
            applicableGrantRefs: ["tool:sessions_spawn"],
            externalNativeActions: "observable",
          });
        }
      } finally {
        releaseAgentRunDelegatedAuthority(authority);
      }
    },
  );

  it("aborts a collector cancelled while Gateway acceptance is in flight", async () => {
    const gatewayContext = makeGatewayContext();
    const firstLaunchGate = createDeferredCore();
    const firstDispatch = createDeferredCore();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let launchCount = 0;
    const transport = vi.fn(async () => {
      throw new Error("Hosted collector cleanup must not open a Gateway transport");
    });
    subagentSpawnTesting.setDepsForTest({
      callGateway: transport,
      dispatchGatewayMethodInProcess: async <T>(method, params) => {
        requests.push({ method, params });
        if (method === "agent") {
          const launchOrdinal = ++launchCount;
          if (launchOrdinal === 1) {
            firstDispatch.resolve();
            await firstLaunchGate.promise;
          }
          return { runId: `gateway-run-${launchOrdinal}`, status: "accepted" } as T;
        }
        return {} as T;
      },
    });

    const parentAdmission = tryBeginGatewayRootWorkAdmission();
    expect(parentAdmission).not.toBeNull();
    const results = await parentAdmission!.run(() =>
      inGateway(
        () =>
          Promise.all([
            // Arrival order may differ from Promise.all result order.
            firstDispatch.promise.then(() =>
              collector("queued collector", "swarm-cancel-launch", "cancelled"),
            ),
            collector("in-flight collector", "swarm-cancel-launch", "next"),
          ]),
        gatewayContext,
      ),
    );
    parentAdmission!.release();
    await waitForAssertion(() => expect(launchCount).toBe(1));
    const firstRequest = expectDefined(
      requests.find((request) => request.method === "agent"),
      "in-flight Gateway request",
    );
    const firstRunId = expectDefined(
      results.find((result) => result.runId === firstRequest.params.idempotencyKey)?.runId,
      "accepted in-flight collector",
    );
    const nextRunId = expectDefined(
      results.find((result) => result.runId !== firstRunId)?.runId,
      "queued collector",
    );

    expect(await markSubagentRunTerminated({ runId: firstRunId, reason: "manual kill" })).toBe(1);
    const killedEntry = expectDefined(subagentRuns.get(firstRunId!), "killed collector");
    const killedSnapshot = structuredClone(killedEntry);
    const killedExecution = killedSnapshot.execution;
    expect(killedSnapshot).toMatchObject({
      endedReason: "subagent-killed",
      execution: {
        status: "terminal",
        endedAt: expect.any(Number),
        outcome: { status: "error", error: "manual kill" },
      },
    });
    firstLaunchGate.resolve();

    await waitForAssertion(() => {
      expect(
        requests.some(
          (request) => request.method === "chat.abort" && request.params.runId === "gateway-run-1",
        ),
      ).toBe(true);
      expect(launchCount).toBe(2);
      expect(subagentRuns.get(firstRunId!)).toEqual({
        ...killedSnapshot,
        swarmLaunchPending: false,
        queuedLaunch: undefined,
        collectorLaunchCleanupPending: false,
        completion: {
          required: false,
          resultText: "manual kill",
          capturedAt: killedExecution.endedAt,
        },
        collectorCompletion: { status: "killed" },
        structuredOutput: undefined,
        archiveAtMs: expectDefined(killedExecution.endedAt, "killed run end") + 60 * 60_000,
        cleanupCompletedAt: expect.any(Number),
        contextEngineCleanupCompletedAt: expect.any(Number),
      });
      const settledEntry = expectDefined(subagentRuns.get(firstRunId!), "settled collector");
      expect(settledEntry.cleanupCompletedAt).toBe(settledEntry.contextEngineCleanupCompletedAt);
      expect(settledEntry.cleanupCompletedAt).toBeGreaterThanOrEqual(killedExecution.endedAt!);
      expect(subagentRuns.get("gateway-run-2")).toMatchObject({
        swarmRunId: nextRunId,
        swarmLaunchPending: false,
      });
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not abort an out-of-process run when registry persistence fails", async () => {
    const gatewayContext = makeGatewayContext();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => false,
      callGateway: async <T>(request: { method: string; params?: unknown }) => {
        requests.push({
          method: request.method,
          params: (request.params ?? {}) as Record<string, unknown>,
        });
        return {
          runId: request.method === "agent" ? "gateway-owned-unregistered-run" : undefined,
          status: "accepted",
        } as T;
      },
    });
    persistRegistryRows.mockImplementation(() => {
      throw new Error("state db unavailable");
    });

    const result = await inGateway(
      () =>
        spawnSubagentDirect(
          { task: "keep remote ownership", context: "isolated", lightContext: true },
          { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
        ),
      gatewayContext,
    );

    expect(result.status).toBe("error");
    expect(result.error ?? "").toContain("Failed to register subagent run");
    expect(requests.some((request) => request.method === "chat.abort")).toBe(false);
  });
});
