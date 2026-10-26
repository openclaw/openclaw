import { vi } from "vitest";

const recoveryDiscoveryMocks = vi.hoisted(() => ({
  discover: vi.fn(),
  entries: vi.fn(),
  pending: vi.fn(),
}));

vi.mock(
  import("../agents/main-session-recovery/main-session-restart-recovery-shared.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    discoverRestartRecoveryStoreTargets: recoveryDiscoveryMocks.discover,
  }),
);
vi.mock(import("../config/sessions/session-entry-read-maintenance.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readPendingInputRecoveryEntriesInWorker: recoveryDiscoveryMocks.entries,
}));
vi.mock(import("../config/sessions/session-pending-input-history.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readSessionSendRecoveryPage: recoveryDiscoveryMocks.pending,
}));

export { recoveryDiscoveryMocks };
