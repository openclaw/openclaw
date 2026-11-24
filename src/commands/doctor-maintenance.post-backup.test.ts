import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { updateMigrateCommand } from "../cli/update-cli/update-command-migrate.js";
import * as contributions from "../flows/doctor-health-contributions.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as doctorUi from "./doctor-ui.js";

afterEach(() => vi.restoreAllMocks());

it("reuses only the backed-up shared source during native update Doctor checks", async () => {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_SUPERVISOR_MODE: "external" },
    },
    async (state) => {
      vi.spyOn(doctorUi, "maybeRepairUiProtocolFreshness").mockResolvedValue();
      await state.writeConfig({
        plugins: { enabled: false },
        gateway: { mode: "local", auth: { mode: "none" }, controlUi: { enabled: false } },
      });
      const options = { env: state.env };
      const source = openOpenClawStateDatabase(options).path;
      const other = { ...options, path: state.path("other.sqlite") };
      openOpenClawStateDatabase(other);
      await closeOpenClawStateDatabaseAsync();
      const backupRoot = state.path("update-recovery", "native");
      const receiptPath = `${backupRoot}.receipt.json`;
      const location = (db: EngineConnection) =>
        isPostgresSqlConnection(db) ? undefined : db.location();
      const outside = await openExistingOpenClawStateDatabaseReadOnly(options);
      expect(outside).toBeDefined();
      if (!outside) {
        throw new Error("Missing test database");
      }
      expect(location(outside.db)).not.toBe(source);
      expect(outside.walMaintenance.close()).toBe(true);
      let nativeReader: OpenClawStateDatabase | undefined;
      const runChecks = contributions.runDoctorHealthContributions;
      const probe = vi
        .spyOn(contributions, "runDoctorHealthContributions")
        .mockImplementation(async (ctx) => {
          expect(JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe("backed-up");
          await withOpenClawStateDatabaseReadSnapshot(async () => {
            expect.soft(getActiveOpenClawStateDatabaseReadSnapshot(options)?.location).toBe(source);
            const result = await executeExistingOpenClawStateRead(options, { type: "backup.runs" });
            expect(result?.runs).toBeDefined();
            const read = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
              ({ db }) => location(db),
              options,
            );
            expect.soft(read).toBe(source);
          }, options);
          // The grant is not a blanket artifact-preservation bypass for another store.
          expect(
            withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
              ({ db }) => location(db),
              other,
            ),
          ).not.toBe(other.path);
          const opened = await openExistingOpenClawStateDatabaseReadOnly(options);
          expect.soft(opened && location(opened.db)).toBe(source);
          if (opened && location(opened.db) === source) {
            // Leave the handle to the maintenance owner rather than closing it here.
            nativeReader = opened;
          } else {
            opened?.walMaintenance.close();
          }
          const copy = [
            vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation"),
            vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync"),
            vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationAwaited"),
            vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync"),
          ];
          await runChecks(ctx);
          expect(
            copy.flatMap((prepare) => prepare.mock.calls.map(([pathname]) => pathname)),
          ).not.toContain(source);
        });
      await updateMigrateCommand(backupRoot);
      expect(probe).toHaveBeenCalledOnce();
      expect(nativeReader?.db.isOpen).toBe(false);
      expect(JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe("migrated");
    },
  );
});
