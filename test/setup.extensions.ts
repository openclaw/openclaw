// Extension test setup installs extension-specific mocks and cleanup.
import { afterAll, beforeEach, vi } from "vitest";
import { installSharedTestSetup } from "./setup.shared.js";

const testEnv = installSharedTestSetup({ loadProfileEnv: false });

beforeEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  const { drainAgentDatabaseResources } = await vi.importActual<
    typeof import("../src/state/openclaw-agent-db-resources.js")
  >("../src/state/openclaw-agent-db-resources.js");
  // File-owned homes must survive until retained Worker leases have been released.
  await drainAgentDatabaseResources({}, async () => {
    testEnv.cleanup();
  });
});
