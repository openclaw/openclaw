import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();
const workspace = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: workspace.preflight,
}));

import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as support from "./worker-environments/service.test-support.js";

describe("reclaimed worker automatic resume", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([
    { executionMode: "remote-exec", outcome: "completed" },
    { executionMode: "worker-turn", outcome: "stopped" },
    { executionMode: "remote-exec", outcome: "stopped" },
    { executionMode: "worker-turn", outcome: "superseded" },
    { executionMode: "remote-exec", outcome: "superseded" },
  ] as const)("resumes $executionMode until $outcome", async ({ executionMode, outcome }) => {
    const actual = await vi.importActual<
      typeof import("./worker-environments/placement-dispatch.js")
    >("./worker-environments/placement-dispatch.js");
    runtimeFactoryMocks.createDispatch.mockImplementation(
      actual.createWorkerPlacementDispatchService,
    );
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({ read: vi.fn(), version: () => 0 });

    const { root, stateDb, config } = support.testState;
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
      storePath: path.join(root, "sessions.sqlite"),
      canonicalKey: REQUEST.sessionKey,
      store: { [REQUEST.sessionKey]: entry },
      storeKeys: [REQUEST.sessionKey],
    };
    await upsertSessionEntryCore(target, entry);
    const worktree = { id: entry.worktree.id, ownerId: REQUEST.sessionKey, path: root };
    moveDestinationMocks.getRuntimeConfig.mockReturnValue(config);
    moveDestinationMocks.resolveGatewaySessionTarget.mockReturnValue(target);
    moveDestinationMocks.resolveCanonicalSession.mockReturnValue(entry);
    moveDestinationMocks.findManagedWorktree.mockReturnValue(worktree);
    moveDestinationMocks.resolveExecutionMode.mockReturnValue(executionMode);
    moveDestinationMocks.resolveSessionRuntime.mockReturnValue(
      executionMode === "remote-exec" ? "codex" : "openclaw",
    );
    const targetOwner = await vi.importActual<
      typeof import("./server-worker-placement-session-target.js")
    >("./server-worker-placement-session-target.js");
    moveDestinationMocks.resolveSessionTarget.mockImplementation(
      targetOwner.resolveWorkerPlacementSessionTarget,
    );

    const placements = createWorkerSessionPlacementStore({ database: stateDb });
    const previous = createHarness(stateDb, placements, { workspacePath: root });
    const active = await previous.service.dispatch({ ...REQUEST, executionMode });
    const placement = await previous.service.reclaim(REQUEST);
    previous.markEnvironmentFailed();
    const previousEnvironment = previous.environments.get(active.environmentId);
    const replacement = createHarness(stateDb, placements, {
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
    const runtime = createGatewayWorkerPlacementRuntime({
      placements,
      environments,
      gatewayNamespace: "gateway-resume-test",
      warn: vi.fn(),
      cancelSessionWork: vi.fn(async () => {}),
      revokeSessionAuthority: vi.fn(),
    });
    const setupEntered = createDeferredCore<AbortSignal | undefined>();
    const releaseSetup = createDeferredCore();
    workspace.preflight.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      setupEntered.resolve(signal);
      await releaseSetup.promise;
      signal?.throwIfAborted();
    });
    const controller = new AbortController();
    const admission = await beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [REQUEST.sessionKey, REQUEST.sessionId],
      assertAllowed: () => controller.signal.throwIfAborted(),
      onInterrupt: (reason) => controller.abort(reason),
    });

    let current = true;
    const termination = new Error(`Turn ${outcome}`);
    const runLocal = vi.fn(async () => {
      expect(controller.signal.aborted).toBe(false);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "active",
        environmentId: replacement.ready.environmentId,
        turnClaim: { owner: "local", runId },
      });
      return { payloads: [{ text: "The resumed workspace is ready." }], meta: { durationMs: 1 } };
    });
    const pending = admission
      .run(() =>
        runtime.admissionProvider.executeTurn(
          { ...REQUEST, runId },
          {
            ...REQUEST,
            runId,
            config,
            sessionTarget: target,
            sessionFile: REQUEST.sessionKey,
            workspaceDir: root,
            prompt: "Continue",
            timeoutMs: 60_000,
            abortSignal: controller.signal,
          },
          runLocal,
          undefined,
          () => {
            if (!current) {
              throw termination;
            }
          },
        ),
      )
      .catch((error: unknown) => error);
    try {
      const signal = await Promise.race([
        setupEntered.promise,
        pending.then((result) => {
          throw result;
        }),
      ]);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "reclaimed",
        turnClaim: null,
      });
      expect(runLocal).not.toHaveBeenCalled();
      if (outcome === "stopped") {
        controller.abort(termination);
        expect(signal?.aborted).toBe(true);
      } else if (outcome === "superseded") {
        current = false;
      }
      releaseSetup.resolve();
      if (outcome === "completed") {
        expect(await pending).toMatchObject({
          payloads: [{ text: "The resumed workspace is ready." }],
        });
        expect(runLocal).toHaveBeenCalledOnce();
        expect(replacement.environments.createFromProfileSnapshot).toHaveBeenCalledOnce();
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "active",
          environmentId: replacement.ready.environmentId,
          turnClaim: null,
          workspaceBaseManifestRef: replacement.reconciledManifestRef,
        });
        expect(placements.listPendingWorkspaceResults()).toEqual([]);
        expect(controller.signal.aborted).toBe(false);
      } else {
        expect(await pending).toBe(termination);
        expect(replacement.environments.create).not.toHaveBeenCalled();
        expect(replacement.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
        expect(runLocal).not.toHaveBeenCalled();
        expect(placements.get(REQUEST.sessionId)).toMatchObject({
          state: "reclaimed",
          turnClaim: null,
        });
      }
    } finally {
      releaseSetup.resolve();
      await pending;
      admission.release();
      closeOpenClawAgentDatabases(root);
    }
  });
});
