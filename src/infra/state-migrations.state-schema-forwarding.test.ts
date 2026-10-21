// Proves runLegacyStateMigrations forwards its integrity mode into the state-schema step.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { createCallerModeExecutionFixture } from "./state-migrations.caller-mode.test-helpers.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";

let stateDatabase = await import("../state/openclaw-state-db.js");

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  stateDatabase.closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

async function runWithIntegrityCheck(integrityCheck?: "quick" | "full") {
  const root = await tempDirs.make("openclaw-state-schema-forwarding-");
  const fixture = createCallerModeExecutionFixture(root);
  const detected = await detectLegacyStateMigrations({
    cfg: {},
    env: fixture.env,
    homedir: () => fixture.homeDir,
    doctorOnlyStateMigrations: true,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
  // Keep the assertion focused on the constructed step options, not SQLite repair.
  const prepare = vi
    .spyOn(stateDatabase, "prepareOpenClawStateDatabaseSchema")
    .mockResolvedValue({ changes: [], warnings: [] });
  await runLegacyStateMigrations({
    detected,
    config: {},
    env: fixture.env,
    ...(integrityCheck ? { integrityCheck } : {}),
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
  return prepare;
}

describe("state-schema migration integrity forwarding", () => {
  it("passes integrityCheck=full into the state-schema preparation step", async () => {
    const prepare = await runWithIntegrityCheck("full");

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ integrityCheck: "full" }),
      expect.anything(),
    );
  });

  it("keeps the quick default when no integrity mode is requested", async () => {
    const prepare = await runWithIntegrityCheck();

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ integrityCheck: undefined }),
      expect.anything(),
    );
  });
});
