import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const postgres = vi.hoisted(() => ({
  create: vi.fn(() => {
    throw new Error("SQLite must not construct PostgreSQL runtime data");
  }),
}));

vi.mock("./postgres-schema.generated/runtime.js", () => ({
  createStatePostgresRuntime: postgres.create,
  get statePostgresRuntime() {
    throw new Error("SQLite must not construct PostgreSQL runtime data");
  },
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("opens, reopens, and reads SQLite state without constructing PostgreSQL runtime data", async () => {
  // Import is part of the boundary: no PostgreSQL object may be built before the opener runs.
  const { closeOpenClawStateDatabaseForTest, openOpenClawStateDatabase } =
    await import("./openclaw-state-db.js");
  const { openOpenClawStateReadConnection } =
    await import("./openclaw-state-db-read-connection.js");
  const env = { OPENCLAW_STATE_DIR: dirs.make("state-lazy-postgres-") };
  try {
    const first = openOpenClawStateDatabase({ env });
    const pathname = first.path;
    expect(
      first.db.prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ role: "global" });
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env });
    expect(reopened.path).toBe(pathname);
    const reader = openOpenClawStateReadConnection(pathname, pathname);
    try {
      expect(
        reader.database.db.prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ role: "global" });
    } finally {
      reader.close(false);
    }
    expect(postgres.create).not.toHaveBeenCalled();
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
});
