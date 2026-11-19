import { afterEach, beforeEach, expect, vi } from "vitest";
import type { OpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-async-lifecycle.js";

const leaseMocks = vi.hoisted(() => ({
  registerResource: vi.fn<(resource: OpenClawStateDatabaseAsyncResource) => () => void>(),
  isWriteContention: vi.fn<(_error: unknown) => boolean>(() => false),
  forbidden: vi.fn(() => {
    throw new Error("Controlled lease test reached native storage, identity lookup, or transport");
  }),
}));
export { leaseMocks };
// mock-isolation: Track resource ownership without opening a native database cache.
vi.mock("./openclaw-state-db-cache.js", () => ({
  registerOpenClawStateDatabaseAsyncResource: leaseMocks.registerResource,
}));
// mock-isolation: Controlled lease tests must not register real process-exit handlers.
vi.mock("./openclaw-state-lease-process-exit.js", () => ({
  registerProcessExitLeaseCleanup: () => () => {},
}));
// mock-isolation: Native storage is forbidden; the fixture drives lease outcomes explicitly.
vi.mock("./openclaw-state-lease-storage.js", () => ({
  STATE_LEASE_WRITE_BACKOFF: { initialMs: 25, maxMs: 250, factor: 1.5, jitter: 0.25 },
  createOpenClawStateLeaseLostErrorFromDatabase: leaseMocks.forbidden,
  isOpenClawStateLeaseWriteContention: leaseMocks.isWriteContention,
  releaseOpenClawStateLeaseBestEffort: async (_params: unknown, execute?: () => Promise<void>) =>
    execute?.(),
  resolveLeaseDatabasePath: leaseMocks.forbidden,
  renewOpenClawStateLease: leaseMocks.forbidden,
  verifyOpenClawStateLeaseOwnership: leaseMocks.forbidden,
  releaseOpenClawStateLease: leaseMocks.forbidden,
}));
// mock-isolation: Reject unexpected native database reads from the controlled lease owner.
vi.mock("./openclaw-state-db-readonly.js", () => ({
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly: leaseMocks.forbidden,
}));
vi.mock("../infra/sqlite-worker-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-worker-identity.js")>()),
  inspectDatabasePathIdentitySync: leaseMocks.forbidden,
  readDatabasePathIdentitySync: leaseMocks.forbidden,
}));
beforeEach(() => {
  vi.clearAllMocks();
  leaseMocks.isWriteContention.mockReturnValue(false);
});
afterEach(() => expect(leaseMocks.forbidden).not.toHaveBeenCalled());
