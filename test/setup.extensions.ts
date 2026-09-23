// Extension test setup installs extension-specific mocks and cleanup.
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { installSharedTestSetup } from "./setup.shared.js";

const testEnv = installSharedTestSetup({ loadProfileEnv: false });
let restoreUpstreamLinks: (() => void) | undefined;

beforeEach(async () => {
  vi.useRealTimers();
  if (
    !expect
      .getState()
      .testPath?.replaceAll("\\", "/")
      .match(
        /\/extensions\/codex\/src\/app-server\/upstream-(?:fork-import|session-fork|session-fork-continuation)\.test\.ts$/,
      )
  ) {
    return;
  }
  // Shared initialization calls the core owner; extension fixtures keep their public SDK mocks.
  const [owner, facade] = await Promise.all([
    vi.importActual<typeof import("../src/sessions/session-upstream-links.js")>(
      "../src/sessions/session-upstream-links.js",
    ),
    vi.importMock<typeof import("openclaw/plugin-sdk/session-catalog")>(
      "openclaw/plugin-sdk/session-catalog",
    ),
  ]);
  const upsert = vi
    .spyOn(owner, "upsertSessionUpstreamLink")
    .mockImplementation(facade.upsertSessionUpstreamLink);
  const remove = vi
    .spyOn(owner, "deleteSessionUpstreamLink")
    .mockImplementation(facade.deleteSessionUpstreamLink);
  restoreUpstreamLinks = () => {
    upsert.mockRestore();
    remove.mockRestore();
  };
});

afterEach(() => {
  restoreUpstreamLinks?.();
  restoreUpstreamLinks = undefined;
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
