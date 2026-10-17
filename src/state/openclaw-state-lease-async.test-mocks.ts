import { afterEach, beforeEach, expect, vi } from "vitest";
import type { OpenClawStateDatabaseAsyncResource } from "./openclaw-state-db-async-lifecycle.js";

export const leaseMocks = vi.hoisted(() => ({
  registerResource: vi.fn<(resource: OpenClawStateDatabaseAsyncResource) => () => void>(),
  isWriteContention: vi.fn<(_error: unknown) => boolean>(() => false),
  forbidden: vi.fn(() => {
    throw new Error("Controlled lease test reached native storage, identity lookup, or transport");
  }),
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  registerOpenClawStateDatabaseAsyncResource: leaseMocks.registerResource,
}));
vi.mock("./openclaw-state-lease-process-exit.js", () => ({
  registerProcessExitLeaseCleanup: () => () => {},
}));
vi.mock("./openclaw-state-lease-storage.js", () => ({
  STATE_LEASE_WRITE_BACKOFF: { initialMs: 25, maxMs: 250, factor: 1.5, jitter: 0.25 },
  isOpenClawStateLeaseWriteContention: leaseMocks.isWriteContention,
  releaseOpenClawStateLeaseBestEffort: async (_params: unknown, execute?: () => Promise<void>) =>
    execute?.(),
  resolveLeaseDatabasePath: leaseMocks.forbidden,
  renewOpenClawStateLease: leaseMocks.forbidden,
  verifyOpenClawStateLeaseOwnership: leaseMocks.forbidden,
  releaseOpenClawStateLease: leaseMocks.forbidden,
}));
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
