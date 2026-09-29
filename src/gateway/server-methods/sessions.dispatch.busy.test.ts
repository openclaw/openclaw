import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { getWorkerPlacementStartupMocks } from "../server-worker-placement-startup.test-harness.js";
const { runtimeFactoryMocks, moveDestinationMocks } = getWorkerPlacementStartupMocks();
const workspace = vi.hoisted(() => ({ preflight: vi.fn() }));
vi.mock("../worker-environments/workspace-sync-preflight.js", () => ({
  preflightWorkerWorkspace: workspace.preflight,
}));
import * as queues from "../../auto-reply/reply/queue/cleanup.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as repositoryWorkspaces from "../../state/session-repository-workspaces.js";
import { createGatewayWorkerPlacementRuntime } from "../server-worker-placement-startup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "../session-utils.js";
import { REQUEST } from "../worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import * as support from "../worker-environments/service.test-support.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
import type { GatewayRequestContext } from "./types.js";

describe("sessions.dispatch preserves admitted local work", () => {
  support.setupWorkerEnvironmentServiceSuite();
  beforeEach(async () => {
    const actual = await vi.importActual<
      typeof import("../worker-environments/placement-dispatch.js")
    >("../worker-environments/placement-dispatch.js");
    runtimeFactoryMocks.createDispatch.mockImplementation(
      actual.createWorkerPlacementDispatchService,
    );
    runtimeFactoryMocks.createDiskSpace.mockReturnValue({ read: vi.fn(), version: () => 0 });
    workspace.preflight.mockReset().mockResolvedValue(undefined);
    moveDestinationMocks.resolveSessionRuntime.mockReturnValue("openclaw");
    moveDestinationMocks.resolveExecutionMode.mockReturnValue("worker-turn");
    const entry = {
      sessionId: REQUEST.sessionId,
      lifecycleRevision: "original",
      worktree: { id: "workspace", branch: "test", repoRoot: support.testState.root },
    };
    const target = {
      agentId: REQUEST.agentId,
      canonicalKey: REQUEST.sessionKey,
      store: { [REQUEST.sessionKey]: entry },
      storeKeys: [REQUEST.sessionKey, "legacy-session-alias"],
      storePath: `${support.testState.root}/sessions.sqlite`,
    };
    const worktree = { id: "workspace", ownerId: REQUEST.sessionKey, path: support.testState.root };
    moveDestinationMocks.getRuntimeConfig.mockReturnValue(support.testState.config);
    moveDestinationMocks.resolveGatewaySessionTarget.mockReturnValue(target);
    moveDestinationMocks.resolveCanonicalSession.mockReturnValue(entry);
    moveDestinationMocks.findManagedWorktree.mockReturnValue(worktree);
    moveDestinationMocks.resolveSessionTarget.mockReturnValue({
      config: support.testState.config,
      target,
      entry,
      worktree,
      workspace: { kind: "local", path: worktree.path },
    });
  });
  it.each([
    { identity: REQUEST.sessionKey, retry: "idle" },
    { identity: REQUEST.sessionKey, retry: "repository" },
    { identity: "legacy-session-alias", retry: "inherited" },
  ] as const)("preserves active $identity work ($retry)", async ({ identity, retry }) => {
    const repositoryStore = repositoryWorkspaces.createSessionRepositoryWorkspaceStore({
      database: support.testState.stateDb,
    });
    const repository =
      retry === "repository"
        ? repositoryStore.create({
            agentId: REQUEST.agentId,
            sessionKey: REQUEST.sessionKey,
            url: "https://github.com/example/project.git",
            assertCurrent: () => {},
          })
        : undefined;
    if (repository) {
      const storeSpy = vi
        .spyOn(repositoryWorkspaces, "getSessionRepositoryWorkspaceStore")
        .mockReturnValue(repositoryStore);
      onTestFinished(() => storeSpy.mockRestore());
      const entry = {
        sessionId: REQUEST.sessionId,
        repositoryWorkspaceId: repository.workspaceId,
        updatedAt: 1,
      };
      const target = {
        ...moveDestinationMocks.resolveGatewaySessionTarget(),
        store: { [REQUEST.sessionKey]: entry },
      };
      moveDestinationMocks.resolveGatewaySessionTarget.mockReturnValue(target);
      vi.mocked(resolveCanonicalSessionEntryFromStoreKeys).mockReturnValue(entry);
      moveDestinationMocks.resolveSessionTarget.mockReturnValue({
        config: support.testState.config,
        target,
        entry,
        worktree: undefined,
        workspace: { kind: "repository", repository },
      });
    }
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const harness = createHarness(support.testState.stateDb, placements, {
      workspacePath: support.testState.root,
    });
    const environments = {
      ...support.createService(support.createProvider()),
      ...harness.environments,
      supportsExecutionMode: () => true,
    };
    const cancelSessionWork = vi.fn(async () => {});
    const revokeSessionAuthority = vi.fn();
    const clearQueues = vi.spyOn(queues, "clearSessionQueues");
    const runtime = createGatewayWorkerPlacementRuntime({
      getCommittedRuntimeConfig: () => support.testState.config,
      placements,
      environments,
      gatewayNamespace: "gateway-test",
      warn: vi.fn(),
      cancelSessionWork,
      revokeSessionAuthority,
    });
    const context = {
      getRuntimeConfig: () => support.testState.config,
      workerEnvironmentService: environments,
      workerSessionPlacementService: placements,
      workerPlacementDispatchService: runtime.dispatchService,
      getSessionEventSubscriberConnIds: () => new Set(),
    } as unknown as GatewayRequestContext;
    const invoke = async () => {
      const respond = vi.fn();
      await sessionDispatchHandlers["sessions.dispatch"]!({
        req: { type: "req", id: "busy-dispatch", method: "sessions.dispatch" },
        params: { key: REQUEST.sessionKey, profileId: "development" },
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });
      return respond;
    };
    const finishTurn = createDeferredCore();
    const writeCompletedResult = vi.fn();
    const interrupted = vi.fn(() => admission.release());
    const admission = await beginSessionWorkAdmission({
      scope: moveDestinationMocks.resolveGatewaySessionTarget().storePath,
      identities: [identity],
      assertAllowed: () => {},
      onInterrupt: interrupted,
    });
    const activeTurn = finishTurn.promise.then(() => {
      if (!interrupted.mock.calls.length) {
        writeCompletedResult();
      }
      admission.release();
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const respond = await invoke();
        expect(interrupted).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: ErrorCodes.UNAVAILABLE,
            message: expect.stringMatching(/active|busy/i),
          }),
        );
        expect(clearQueues).not.toHaveBeenCalled();
        expect(revokeSessionAuthority).not.toHaveBeenCalled();
        expect(cancelSessionWork).not.toHaveBeenCalled();
        expect(workspace.preflight).not.toHaveBeenCalled();
        expect(placements.get(REQUEST.sessionId)).toBeUndefined();
        expect(environments.createWithRequest).not.toHaveBeenCalled();
      }
      finishTurn.resolve();
      await activeTurn;
      expect(writeCompletedResult).toHaveBeenCalledOnce();
      if (repository) {
        expect(repositoryStore.get(repository.workspaceId)).toEqual(repository);
        return;
      }
      const retryAdmission =
        retry === "inherited"
          ? await beginSessionWorkAdmission({
              scope: moveDestinationMocks.resolveGatewaySessionTarget().storePath,
              identities: [identity],
              assertAllowed: () => {},
              onInterrupt: interrupted,
            })
          : undefined;
      const respond = await (retryAdmission ? retryAdmission.run(invoke) : invoke()).finally(() =>
        retryAdmission?.release(),
      );
      expect(interrupted).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          placement: expect.objectContaining({ state: "active" }),
        }),
        undefined,
      );
      expect(environments.createWithRequest).toHaveBeenCalledOnce();
    } finally {
      finishTurn.resolve();
      await activeTurn;
      admission.release();
      clearQueues.mockRestore();
    }
  });
});
