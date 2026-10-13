import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn(),
  worktree: vi.fn(),
  worktreeRead: vi.fn(),
  repository: vi.fn(),
  repositoryWorkspace: vi.fn(),
  session: vi.fn(),
  admittedSessionRead: vi.fn(),
  nativeToken: vi.fn(),
  oauth: vi.fn(),
}));

vi.mock("../../agents/github-oauth-client.js", () => ({ verifyGitHubCredential: mocks.verify }));
vi.mock("../github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: mocks.refresh,
}));
vi.mock("../../secrets/runtime-state.js", () => ({
  getActiveSecretsRuntimeConfigSnapshot: mocks.snapshot,
}));
vi.mock("../../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    findLiveByOwner: mocks.worktree,
    resolveRepositoryIdentity: mocks.repository,
  },
}));
vi.mock("../../agents/worktrees/registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/worktrees/registry-read.js")>()),
  readLiveRegistryWorktreeByOwner: async (_context: unknown, kind: string, id: string) =>
    mocks.worktreeRead(kind, id),
}));
vi.mock("../session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.session }));
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  withSessionEntryReadOnlyInWorker: async <T>(
    scope: Parameters<
      typeof import("../../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker
    >[0],
    assertCurrent: () => void,
    consume: Parameters<
      typeof import("../../config/sessions/session-entry-read-runtime.js").withSessionEntryReadOnlyInWorker<T>
    >[2],
  ) => {
    const loaded = await mocks.admittedSessionRead(scope, assertCurrent);
    assertCurrent();
    return await consume(
      {
        ok: true,
        value: loaded.entries.find(
          (row: { sessionKey: string }) => row.sessionKey === scope.sessionKey,
        )?.entry,
      },
      {
        kind: "file",
        assertCurrent,
        source: {
          agentId: scope.agentId ?? "main",
          path: scope.storePath ?? "/synthetic/admitted.sqlite",
          databaseIdentity: "worker-github-binding-fixture",
        },
      },
    );
  },
}));
vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) => {
    const loaded = mocks.session(params.key, { agentId: params.agentId });
    params.onSelected?.({
      ...loaded,
      storeKeys: [loaded.canonicalKey],
      store: { [loaded.canonicalKey]: loaded.entry },
      capturedReadSource: {
        agentId: loaded.agentId,
        path: loaded.storePath ?? "/synthetic/admitted.sqlite",
        databaseIdentity: "worker-github-binding-fixture",
      },
    });
    return loaded;
  },
}));
vi.mock("../../state/session-repository-workspaces.js", () => ({
  getSessionRepositoryWorkspaceStore: () => ({
    prepare: async () => ({
      workspace: mocks.repositoryWorkspace(),
      current: mocks.repositoryWorkspace,
    }),
  }),
}));
// mock-isolation: Grant tests control OAuth expiry without reading the persistent credential store.
vi.mock("../../agents/github-oauth-records.js", () => ({ inspectGitHubOAuthRecord: mocks.oauth }));
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: mocks.nativeToken }));

export function getWorkerGitHubBindingMocks() {
  return mocks;
}
