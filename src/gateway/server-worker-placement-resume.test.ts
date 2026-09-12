import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";

const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();
const workspace = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("./worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: workspace.preflight,
}));

import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner/types.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabases } from "../state/openclaw-agent-db.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as support from "./worker-environments/service.test-support.js";

async function createResumeHarness(executionMode: "worker-turn" | "remote-exec") {
  const actual = await vi.importActual<
    typeof import("./worker-environments/placement-dispatch.js")
  >("./worker-environments/placement-dispatch.js");
  runtimeFactoryMocks.createDispatch.mockImplementation(
    actual.createWorkerPlacementDispatchService,
  );
  runtimeFactoryMocks.createDiskSpace.mockReturnValue({ read: vi.fn(), version: () => 0 });

  const { root, stateDb, config } = support.testState;
  const sessionTarget = {
    agentId: REQUEST.agentId,
    sessionId: REQUEST.sessionId,
    sessionKey: REQUEST.sessionKey,
    storePath: path.join(root, "sessions.sqlite"),
  };
  const runId = `resumed-${executionMode}-turn`;
  const entry = {
    sessionId: REQUEST.sessionId,
    lifecycleRevision: "resume-generation",
    activeWriterRunId: runId,
    updatedAt: Date.now(),
    worktree: { id: "resume-workspace", branch: "resume-workspace", repoRoot: root },
  };
  await upsertSessionEntryCore(sessionTarget, entry);
  SessionManager.open(sessionTarget);
  const target = {
    ...sessionTarget,
    canonicalKey: REQUEST.sessionKey,
    store: { [REQUEST.sessionKey]: entry },
    storeKeys: [REQUEST.sessionKey],
  };
  const worktree = { id: entry.worktree.id, ownerId: REQUEST.sessionKey, path: root };
  moveDestinationMocks.getRuntimeConfig.mockReturnValue(config);
  moveDestinationMocks.resolveGatewaySessionTarget.mockReturnValue(target);
  moveDestinationMocks.resolveCanonicalSession.mockReturnValue(entry);
  moveDestinationMocks.findManagedWorktree.mockReturnValue(worktree);
  moveDestinationMocks.resolveExecutionMode.mockReturnValue(executionMode);
  moveDestinationMocks.resolveSessionRuntime.mockReturnValue(
    executionMode === "remote-exec" ? "codex" : "openclaw",
  );
  moveDestinationMocks.resolveSessionTarget.mockReturnValue({
    config,
    target,
    entry,
    worktree,
    workspace: { kind: "local", path: root },
  });

  const placements = createWorkerSessionPlacementStore({ database: stateDb });
  const previous = createHarness(stateDb, placements, { workspacePath: root });
  const active = previous.placements.seedActive(2, executionMode);
  if (active.state !== "active") {
    throw new Error("Expected an active worker fixture");
  }
  const draining = placements.startDrain({
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: active.generation,
  });
  const reconciling = placements.startReconcile({
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: draining.generation,
  });
  const reclaimed = placements.transition({
    sessionId: active.sessionId,
    from: "reconciling",
    to: "reclaimed",
    expectedGeneration: reconciling.generation,
  });
  previous.markEnvironmentFailed();
  const previousEnvironment = previous.environments.get(active.environmentId);
  const replacement = createHarness(stateDb, placements, {
    environmentGeneration: reclaimed.generation + 1,
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
  const setupEntered = createDeferredCore();
  const releaseSetup = createDeferredCore();
  let setupSignal: AbortSignal | undefined;
  workspace.preflight.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
    setupSignal = signal;
    setupEntered.resolve();
    await releaseSetup.promise;
    signal?.throwIfAborted();
  });
  const controller = new AbortController();
  const admission = await beginSessionWorkAdmission({
    scope: sessionTarget.storePath,
    identities: [REQUEST.sessionKey, REQUEST.sessionId],
    assertAllowed: () => controller.signal.throwIfAborted(),
    onInterrupt: (reason) => controller.abort(reason),
  });
  return {
    root,
    runId,
    placements,
    replacement,
    controller,
    admission,
    setupEntered,
    releaseSetup,
    get setupSignal() {
      return setupSignal;
    },
    run: (runLocal: () => Promise<EmbeddedAgentRunResult>, assertCurrent?: () => void) =>
      admission.run(() =>
        runtime.admissionProvider.executeTurn(
          { ...REQUEST, runId },
          {
            ...REQUEST,
            runId,
            config,
            sessionTarget,
            sessionFile: REQUEST.sessionKey,
            workspaceDir: root,
            prompt: "Continue",
            timeoutMs: 60_000,
            abortSignal: controller.signal,
          },
          runLocal,
          undefined,
          assertCurrent,
        ),
      ),
  };
}

describe("reclaimed worker automatic resume", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("reprovisions under the waiting turn's admission and returns one remote-exec reply", async () => {
    const fixture = await createResumeHarness("remote-exec");
    const {
      root,
      runId,
      placements,
      replacement,
      controller,
      admission,
      setupEntered,
      releaseSetup,
    } = fixture;
    const runLocal = vi.fn(async () => {
      expect(controller.signal.aborted).toBe(false);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "active",
        environmentId: replacement.ready.environmentId,
        turnClaim: { owner: "local", runId },
      });
      return { payloads: [{ text: "The resumed workspace is ready." }], meta: { durationMs: 1 } };
    });
    const pending = fixture.run(runLocal);
    try {
      await Promise.race([
        setupEntered.promise,
        pending.then(() => {
          throw new Error("Turn finished before replacement setup");
        }),
      ]);
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "reclaimed",
        turnClaim: null,
      });
      expect(runLocal).not.toHaveBeenCalled();
      releaseSetup.resolve();
      await expect(pending).resolves.toMatchObject({
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
    } finally {
      releaseSetup.resolve();
      await pending.catch(() => {});
      admission.release();
      closeOpenClawAgentDatabases(root);
    }
  });

  it.each([
    { executionMode: "worker-turn", outcome: "stopped" },
    { executionMode: "remote-exec", outcome: "stopped" },
    { executionMode: "worker-turn", outcome: "superseded" },
    { executionMode: "remote-exec", outcome: "superseded" },
  ] as const)(
    "cancels $executionMode replacement setup when its waiting turn is $outcome",
    async ({ executionMode, outcome }) => {
      const fixture = await createResumeHarness(executionMode);
      const { root, placements, replacement, controller, admission, setupEntered, releaseSetup } =
        fixture;
      let current = true;
      const termination = new Error(`Turn ${outcome}`);
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const pending = fixture
        .run(runLocal, () => {
          if (!current) {
            throw termination;
          }
        })
        .catch((error: unknown) => error);
      try {
        await Promise.race([
          setupEntered.promise,
          pending.then((result) => {
            throw result;
          }),
        ]);
        expect(placements.get(REQUEST.sessionId)?.state).toBe("reclaimed");
        if (outcome === "stopped") {
          controller.abort(termination);
          expect(fixture.setupSignal?.aborted).toBe(true);
        } else {
          current = false;
        }
      } finally {
        releaseSetup.resolve();
        await pending;
        admission.release();
        closeOpenClawAgentDatabases(root);
      }
      expect(await pending).toBe(termination);
      expect(replacement.environments.create).not.toHaveBeenCalled();
      expect(replacement.environments.createFromProfileSnapshot).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
      expect(placements.get(REQUEST.sessionId)).toMatchObject({
        state: "reclaimed",
        turnClaim: null,
      });
    },
  );
});
