import { afterEach, beforeEach, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import type { WorkerPlacementSessionWorkCancellation } from "./server-worker-placement-cancel.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { getWorkerPlacementStartupMocks } from "./server-worker-placement-startup.test-harness.js";
import { createRuntimeFactory } from "./server-worker-placement.test-support.js";
import type { WorkerSessionPlacementIdentity } from "./worker-environments/placement-record.js";
import type { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import * as support from "./worker-environments/service.test-support.js";

export function createHeldWorkspacePreflight() {
  const entered = createDeferredCore();
  const aborted = createDeferredCore();
  const release = createDeferredCore();
  let signal: AbortSignal | undefined;
  return {
    entered: entered.promise,
    aborted: aborted.promise,
    release: release.resolve,
    get signal() {
      return signal;
    },
    async run(this: void, request: { signal?: AbortSignal }) {
      signal = request.signal;
      signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await release.promise;
      signal?.throwIfAborted();
    },
  };
}

const runtimeFactory = createRuntimeFactory(createGatewayWorkerPlacementRuntime, getRuntimeConfig);
export async function createRuntime(
  placements: ReturnType<typeof createWorkerSessionPlacementStore>,
  environments: ReturnType<typeof support.createService>,
  cancelSessionWork: WorkerPlacementSessionWorkCancellation = vi.fn(async () => {}),
) {
  return runtimeFactory({
    initialPlacements: await placements.listAsync(),
    placements,
    environments,
    cancelSessionWork,
  });
}

export function setupSessionFixture(request: WorkerSessionPlacementIdentity) {
  beforeEach(async () => {
    const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();
    moveDestinationMocks.prepareGatewaySessionTarget.mockReset();
    const actual = await vi.importActual<
      typeof import("./worker-environments/placement-dispatch.js")
    >("./worker-environments/placement-dispatch.js");
    runtimeFactoryMocks.createDispatch.mockImplementation(
      actual.createWorkerPlacementDispatchService,
    );
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({ read: vi.fn(), version: () => 0 });
    const entry = {
      sessionId: request.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
      worktree: { id: "workspace", branch: "fixture", repoRoot: support.testState.root },
    };
    const storePath = `${support.testState.root}/sessions.sqlite`;
    const config = {
      ...support.testState.config,
      session: { ...support.testState.config.session, store: storePath },
    };
    setRuntimeConfigSnapshot(config, config);
    await upsertSessionEntryCore(
      { agentId: request.agentId, sessionKey: request.sessionKey, storePath },
      entry,
    );
    const targetReader = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
      "./session-utils-store-worker.js",
    );
    moveDestinationMocks.prepareGatewaySessionTarget.mockImplementation(
      targetReader.resolveGatewaySessionStoreTargetInWorker,
    );
    const worktree = { id: "workspace", ownerId: request.sessionKey, path: support.testState.root };
    const target = await targetReader.resolveGatewaySessionStoreTargetInWorker({
      cfg: config,
      key: request.sessionKey,
      agentId: request.agentId,
    });
    moveDestinationMocks.getRuntimeConfig.mockReturnValue(config);
    moveDestinationMocks.resolveGatewaySessionTarget.mockReturnValue(target);
    moveDestinationMocks.resolveCanonicalSession.mockReturnValue(entry);
    moveDestinationMocks.findManagedWorktree.mockReturnValue(worktree);
    moveDestinationMocks.resolveSessionTarget.mockResolvedValue({
      assertCurrent: () => {},
      assertBindingCurrent: () => {},
      config,
      target,
      entry,
      worktree,
      workspace: { kind: "local", path: worktree.path },
      [Symbol.dispose]: () => {},
    });
  });
  // Later teardown hooks run first, before the service fixture removes this directory.
  afterEach(async () => {
    await closeOpenClawAgentDatabaseByPathAsync(
      `${support.testState.root}/sessions.sqlite`,
      request.agentId,
    );
  });
}
