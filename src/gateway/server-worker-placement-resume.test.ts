import path from "node:path";
import { expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();
const workspace = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: workspace.preflight,
}));

import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { createRuntimeFactory } from "./server-worker-placement.test-support.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as support from "./worker-environments/service.test-support.js";

support.setupWorkerEnvironmentServiceSuite();
const createRuntime = createRuntimeFactory(createGatewayWorkerPlacementRuntime, getRuntimeConfig);

it.each([
  { executionMode: "remote-exec", outcome: "completed", state: "reclaimed" },
  { executionMode: "remote-exec", outcome: "completed", state: "failed" },
  { executionMode: "worker-turn", outcome: "stopped", state: "reclaimed" },
  { executionMode: "remote-exec", outcome: "stopped", state: "reclaimed" },
  { executionMode: "worker-turn", outcome: "superseded", state: "reclaimed" },
  { executionMode: "remote-exec", outcome: "superseded", state: "reclaimed" },
] as const)(
  "resumes $state $executionMode until $outcome",
  async ({ executionMode, outcome, state }) => {
    const actual = await vi.importActual<
      typeof import("./worker-environments/placement-dispatch.js")
    >("./worker-environments/placement-dispatch.js");
    runtimeFactoryMocks.createDispatch.mockImplementation(
      actual.createWorkerPlacementDispatchService,
    );
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({ read: vi.fn(), version: () => 0 });

    const { root, stateDb, config: baseConfig } = support.testState;
    const storePath = path.join(root, "sessions.sqlite");
    const config = { ...baseConfig, session: { store: storePath } };
    const runId = `resumed-${executionMode}-turn`;
    const entry = {
      sessionId: REQUEST.sessionId,
      lifecycleRevision: "resume-generation",
      activeWriterRunId: runId,
      updatedAt: Date.now(),
      worktree: { id: "resume-workspace", branch: "resume-workspace", repoRoot: root },
    };
    const target = {
      ...REQUEST,
      storePath,
      canonicalKey: REQUEST.sessionKey,
      store: { [REQUEST.sessionKey]: entry },
      storeKeys: [REQUEST.sessionKey],
    };
    await upsertSessionEntryCore(target, entry);
    const worktree = { id: entry.worktree.id, ownerId: REQUEST.sessionKey, path: root };
    setRuntimeConfigSnapshot(config, config);
    moveDestinationMocks.getRuntimeConfig.mockReturnValue(config);
    moveDestinationMocks.resolveCanonicalSession.mockReturnValue(entry);
    moveDestinationMocks.findManagedWorktree.mockReturnValue(worktree);
    moveDestinationMocks.resolveExecutionMode.mockReturnValue(executionMode);
    moveDestinationMocks.resolveSessionRuntime.mockReturnValue(
      executionMode === "remote-exec" ? "codex" : "openclaw",
    );
    const targetOwner = await vi.importActual<
      typeof import("./server-worker-placement-session-target.js")
    >("./server-worker-placement-session-target.js");
    const targetReader = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
      "./session-utils-store-worker.js",
    );
    moveDestinationMocks.prepareGatewaySessionTarget
      .mockReset()
      .mockImplementation(targetReader.resolveGatewaySessionStoreTargetInWorker);
    moveDestinationMocks.resolveSessionTarget.mockImplementation(
      targetOwner.resolveWorkerPlacementSessionTarget,
    );

    const placements = createWorkerSessionPlacementStore({ database: stateDb });
    const previous = await createHarness(stateDb, placements, { workspacePath: root });
    const active = await previous.service.dispatch({ ...REQUEST, executionMode });
    if (state === "failed") {
      previous.markEnvironmentFailed();
      await previous.service.reconcileActive(active.environmentId);
    } else {
      await previous.service.reclaim(REQUEST);
    }
    const placement = placements.get(REQUEST.sessionId);
    if (placement?.state !== state) {
      throw new Error(`expected ${state} placement after worker cleanup`);
    }
    previous.markEnvironmentFailed();
    const previousEnvironment = previous.environments.get(active.environmentId);
    const replacement = await createHarness(stateDb, placements, {
      environmentGeneration: placement.generation + 1,
      workspacePath: root,
    });
    const environments = {
      ...support.createService(support.createProvider()),
      ...replacement.environments,
      get: (environmentId: string) =>
        environmentId === active.environmentId
          ? previousEnvironment
          : replacement.environments.get(environmentId),
    };
    const runtime = createRuntime({
      initialPlacements: await placements.listAsync(),
      placements,
      environments,
      gatewayNamespace: "gateway-resume-test",
    });
    const setupEntered = createDeferredCore<AbortSignal | undefined>();
    const releaseSetup = createDeferredCore();
    workspace.preflight.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      setupEntered.resolve(signal);
      await releaseSetup.promise;
      signal?.throwIfAborted();
    });
    const controller = new AbortController();
    const turn = { ...REQUEST, runId, abortSignal: controller.signal };
    const idlePlacement = { state, turnClaim: null };
    const controllerTarget = captureSessionTarget({
      storeScope: target.storePath,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      incarnation: REQUEST.sessionId,
    });

    let current = true;
    const termination = new Error(`Turn ${outcome}`);
    const text = "The resumed workspace is ready.";
    const runLocal = vi.fn(async () => {
      expect(controller.signal.aborted).toBe(false);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "active",
        environmentId: replacement.ready.environmentId,
        turnClaim: { owner: "local", runId },
      });
      return {
        payloads: [{ text }],
        meta: {
          durationMs: 1,
          terminalReply: { disposition: "visible" as const, text },
        },
      };
    });
    const input = {
      ...turn,
      config,
      sessionTarget: target,
      sessionFile: REQUEST.sessionKey,
      workspaceDir: root,
      prompt: "Continue",
      timeoutMs: 60_000,
    };
    const assertCurrent = () => {
      if (!current) {
        throw termination;
      }
    };
    const pending = withSessionTurn({ ...turn, target: controllerTarget }, () =>
      runtime.admissionProvider.executeTurn(turn, input, runLocal, undefined, assertCurrent),
    ).catch((error: unknown) => error);
    try {
      const signal = await Promise.race([
        setupEntered.promise,
        pending.then((result) => {
          throw result;
        }),
      ]);
      expect(placements.get(REQUEST.sessionId)).toMatchObject(idlePlacement);
      expect(runLocal).not.toHaveBeenCalled();
      if (outcome === "stopped") {
        controller.abort(termination);
        expect(signal?.aborted).toBe(true);
      } else if (outcome === "superseded") {
        current = false;
      }
      releaseSetup.resolve();
      if (outcome === "completed") {
        expect(await pending).toMatchObject({ payloads: [{ text }] });
        expect(runLocal).toHaveBeenCalledOnce();
        expect(replacement.environments.createWithRequest).toHaveBeenCalledOnce();
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "active",
          environmentId: replacement.ready.environmentId,
          turnClaim: null,
          workspaceBaseManifestRef: replacement.reconciledManifestRef,
        });
        expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
        expect(controller.signal.aborted).toBe(false);
      } else {
        expect(await pending).toBe(termination);
        expect(replacement.environments.createWithRequest).not.toHaveBeenCalled();
        expect(runLocal).not.toHaveBeenCalled();
        expect(placements.get(REQUEST.sessionId)).toMatchObject(idlePlacement);
      }
    } finally {
      releaseSetup.resolve();
      await pending;
      await closeOpenClawAgentDatabasesAsync(root);
    }
  },
);
