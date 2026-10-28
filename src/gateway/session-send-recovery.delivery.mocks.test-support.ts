import { vi } from "vitest";
import { recoveryDiscoveryMocks } from "./session-send-recovery.discovery.mocks.test-support.js";

const recoverySourceMocks = vi.hoisted(() => ({
  source: vi.fn(),
  load: vi.fn(),
  report: vi.fn(),
  withdraw: vi.fn(),
}));

vi.mock(import("../config/sessions/session-pending-input-source.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readPendingInputSource: recoverySourceMocks.source,
}));
vi.mock(import("../config/sessions/session-accessor.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  appendSessionTranscriptReport: recoverySourceMocks.report,
}));
vi.mock(
  import("../config/sessions/session-pending-input-withdrawal.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    discardSessionPendingInput: recoverySourceMocks.withdraw,
  }),
);
vi.mock(import("./session-utils-store-worker.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGatewaySessionStoreTargetInWorker: recoverySourceMocks.load,
}));

const recoveryDeliveryMocks = { ...recoveryDiscoveryMocks, ...recoverySourceMocks };
export { recoveryDeliveryMocks };
