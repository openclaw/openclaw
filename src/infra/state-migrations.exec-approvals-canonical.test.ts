import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ExecApprovalsMigrationRequiredError } from "./exec-approvals-migration-gate.js";
import {
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { readExecApprovalsPolicyReadOnlyAsync } from "./exec-approvals-store.js";
import * as snapshots from "./sqlite-snapshot.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "./state-migrations.exec-approvals.js";

it.each([false, true])(
  "Doctor backs up legacy SQLite exec policy and publishes stable rows (identical JSON: %s)",
  async (identicalJson) => {
    await withOpenClawTestState({ scenario: "empty" }, async ({ env, stateDir }) => {
      const original = {
        version: 1,
        socket: { path: "/tmp/synthetic-approvals.sock", token: "synthetic-socket-proof" },
        defaults: { security: "allowlist", ask: "always" },
        agents: {
          main: {
            ask: "on-miss",
            allowlist: [{ id: "preserved-rule", pattern: "/usr/bin/rg", lastUsedAt: 42 }],
          },
          default: {
            ask: "always",
            allowlist: [
              "  /usr/bin/git  ",
              {
                pattern: "/usr/bin/cat",
                source: "historical",
                commandText: "obsolete command",
                lastUsedCommand: "cat a.txt",
              },
            ],
            mcpTools: [{ server: "fixture", tool: "read", source: "allow-always", addedAt: 10 }],
          },
        },
      };
      const raw = JSON.stringify(original, null, 2) + "\n";
      const sourcePath = path.join(stateDir, "exec-approvals.json");
      if (identicalJson) {
        fs.writeFileSync(sourcePath, raw, { mode: 0o600 });
      }
      const database = openOpenClawStateDatabase({ env });
      writeExecApprovalsConfigRow({ db: database.db, file: { version: 1 }, raw, now: 73 });
      const readRow = () => database.db.prepare("SELECT * FROM exec_approvals_config").get();
      const before = readRow();
      const displayPath = `${database.path}#exec_approvals_config`;
      expect(() =>
        snapshotFromExecApprovalsRow({ path: displayPath, row: { raw_json: raw } }),
      ).toThrow(ExecApprovalsMigrationRequiredError);
      await expect(readExecApprovalsPolicyReadOnlyAsync({ env })).rejects.toThrow(
        `OPENCLAW_STATE_DIR set to ${stateDir}`,
      );
      expect(readRow()).toEqual(before);
      const migrate = () =>
        migrateLegacyExecApprovals({
          env,
          stateDir,
          detected: detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }),
        });
      const result = await migrate();
      expect(result.warnings).toEqual([]);
      expect(result.changes).toContain(
        "Normalized legacy SQLite exec approvals before runtime access.",
      );
      expect(fs.existsSync(sourcePath)).toBe(false);
      const backups = () =>
        fs
          .readdirSync(path.dirname(database.path))
          .filter((file) => file.startsWith("openclaw.sqlite.pre-exec-approvals-migration-"));
      const retained = backups();
      expect(retained).toHaveLength(1);
      const backupPath = path.join(path.dirname(database.path), retained[0]!);
      expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
      const backup = new DatabaseSync(backupPath, { readOnly: true });
      try {
        expect(backup.prepare("SELECT * FROM exec_approvals_config").get()).toEqual(before);
      } finally {
        backup.close();
      }
      const first = await readExecApprovalsPolicyReadOnlyAsync({ env });
      expect(first.file).toEqual({
        version: 1,
        socket: original.socket,
        defaults: original.defaults,
        agents: {
          main: {
            ask: "on-miss",
            allowlist: [
              original.agents.main.allowlist[0],
              { id: expect.any(String), pattern: "/usr/bin/git" },
              { id: expect.any(String), pattern: "/usr/bin/cat", lastUsedCommand: "cat a.txt" },
            ],
            mcpTools: original.agents.default.mcpTools,
          },
        },
      });
      expect(readRow()).toMatchObject({ updated_at_ms: 73, agent_count: 1, allowlist_count: 3 });
      const canonical = readRow();
      expect(await migrate()).toEqual({ changes: [], warnings: [] });
      expect(await readExecApprovalsPolicyReadOnlyAsync({ env })).toEqual(first);
      expect(readRow()).toEqual(canonical);
      expect(backups()).toEqual(retained);
    });
  },
);

it("Doctor refuses a backup of policy changed after planning even if the source is restored before commit", async () => {
  await withOpenClawTestState({ scenario: "empty" }, async ({ env, stateDir }) => {
    const database = openOpenClawStateDatabase({ env });
    const raw = JSON.stringify({ version: 1, agents: { main: { allowlist: ["/usr/bin/git"] } } });
    writeExecApprovalsConfigRow({ db: database.db, file: { version: 1 }, raw, now: 73 });
    const before = database.db.prepare("SELECT * FROM exec_approvals_config").get();
    const createSnapshot = snapshots.createVerifiedSqliteSnapshot;
    const setSource = database.db.prepare("UPDATE exec_approvals_config SET raw_json = ?");
    const changed = JSON.stringify({ version: 1, defaults: { security: "deny" } });
    const snapshot = vi
      .spyOn(snapshots, "createVerifiedSqliteSnapshot")
      .mockImplementation(async (options) => {
        setSource.run(changed);
        try {
          return await createSnapshot({
            ...options,
            beforePublish: async () => {
              setSource.run(raw);
              await options.beforePublish?.();
            },
          });
        } finally {
          setSource.run(raw);
        }
      });
    try {
      const result = await migrateLegacyExecApprovals({
        env,
        stateDir,
        detected: detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }),
      });
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([
        expect.stringContaining("backup does not match the planned policy"),
      ]);
      expect(database.db.prepare("SELECT * FROM exec_approvals_config").get()).toEqual(before);
      expect(
        fs
          .readdirSync(path.dirname(database.path))
          .filter((name) => name.includes(".pre-exec-approvals-migration-")),
      ).toEqual([]);
    } finally {
      snapshot.mockRestore();
    }
  });
});
