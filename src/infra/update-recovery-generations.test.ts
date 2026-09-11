import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareUpdateRecoveryRollback } from "../cli/update-cli/update-command-rollback-state.js";
import { recordConfigFileWrite } from "../config/write-capture.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite, resolveImmutableSqliteFileUri } from "./node-sqlite.js";
import { captureUpdateRecoveryBackup } from "./update-recovery-backup-create.js";
import {
  createUpdateRecoveryBackup,
  preserveUpdateRecoveryCandidate,
  prepareUpdateRecoveryGeneration,
  verifyUpdateRecoveryBackup,
  retireUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "./update-recovery-backup.js";
import { withUpdateRecoveryConfigWrites } from "./update-recovery-config-writes.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";

const temporaryRoot = vi.hoisted(() => vi.fn<() => string>());
vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: temporaryRoot,
}));
const authority = { assertOwned(this: void) {} };

describe("retained update generations", () => {
  it("refuses candidate sealing while a real agent lease is active, then releases maintenance on refusal", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinator = state.path("coordinator");
      await fs.mkdir(coordinator);
      temporaryRoot.mockReturnValue(coordinator);
      await state.writeConfig({ plugins: { enabled: false } });
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const installRoot = state.path("install");
      await fs.mkdir(installRoot);
      const baseline = await createUpdateRecoveryBackup({
        ...authority,
        installRoot,
        runId: run.runId,
      });
      closeOpenClawStateDatabaseForTest();
      const database = new (requireNodeSqlite().DatabaseSync)(
        state.statePath("state", "openclaw.sqlite"),
      );
      try {
        database
          .prepare(`INSERT INTO agent_database_leases(lease_id,agent_id,path,owner_pid,opened_at)
          VALUES ('active-agent','main','agent.sqlite',?,1)`)
          .run(process.pid);
      } finally {
        database.close();
      }
      await expect(prepareUpdateRecoveryRollback(baseline, authority.assertOwned)).rejects.toThrow(
        /database is still open/,
      );
      await expect(fs.lstat(path.join(baseline.directory, "candidate"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const released = new (requireNodeSqlite().DatabaseSync)(
        state.statePath("state", "openclaw.sqlite"),
      );
      try {
        expect(
          released
            .prepare("SELECT owner_pid FROM agent_database_leases WHERE lease_id='active-agent'")
            .get(),
        ).toEqual({ owner_pid: process.pid });
        released.exec("DELETE FROM agent_database_leases WHERE lease_id='active-agent'");
      } finally {
        released.close();
      }
      await expect(prepareUpdateRecoveryRollback(baseline, authority.assertOwned)).rejects.toThrow(
        /Rollback publication is unavailable/,
      );
      // Reacquisition after rejection proves the real scope was settled, not
      // merely that a mock release method was invoked.
      const { beginDoctorMaintenance } = await import("../commands/doctor-maintenance.js");
      const { defaultRuntime } = await import("../runtime.js");
      const maintenance = await beginDoctorMaintenance({
        root: null,
        options: { repair: true },
        runtime: defaultRuntime,
      });
      expect(maintenance).toBeDefined();
      await maintenance?.release();
      await verifyUpdateRecoveryBackup(baseline);
    });
  });
  it("captures a shared database alias with one canonical payload identity", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinator = state.path("coordinator");
      await fs.mkdir(coordinator);
      temporaryRoot.mockReturnValue(coordinator);
      await state.writeConfig({ plugins: { enabled: false } });
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      closeOpenClawStateDatabaseForTest();
      const alias = state.statePath("state", "openclaw.sqlite");
      const target = state.path("external.sqlite");
      await fs.rename(alias, target);
      await fs.symlink(target, alias);
      const installRoot = state.path("install");
      await fs.mkdir(installRoot);
      // The ledger's existing-state writer independently refuses a symlinked
      // shared database. Exercise the real capture owner without changing that
      // write-admission contract or claiming end-to-end shared-alias support.
      const baseline = await captureUpdateRecoveryBackup({
        ...authority,
        installRoot,
        runId: run.runId,
      });
      const before = await verifyUpdateRecoveryBackup(baseline);
      const candidate = await captureUpdateRecoveryBackup({
        ...authority,
        installRoot,
        runId: run.runId,
        baseline: { ref: baseline, manifest: before },
      });
      for (const ref of [baseline, candidate]) {
        const manifest = await verifyUpdateRecoveryBackup(ref);
        expect(manifest.databases?.filter((entry) => entry.role === "global")).toEqual([
          { path: target, role: "global" },
        ]);
        expect(manifest.entries).toContainEqual({ kind: "symlink", sourcePath: alias, target });
        expect(manifest.entries).toContainEqual(
          expect.objectContaining({
            kind: "file",
            sourcePath: target,
            sqlite: true,
          }),
        );
      }
      expect(await fs.readlink(alias)).toBe(target);
    });
  });
  it.each([
    "candidate",
    "prepared",
    "interrupted",
    "binding",
    "foreign",
    "baseline missing",
    "baseline changed",
  ] as const)("retires only verified terminal generations: %s", async (mode) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinator = state.path("coordinator");
      await fs.mkdir(coordinator);
      temporaryRoot.mockReturnValue(coordinator);
      await state.writeConfig({ plugins: { enabled: false } });
      const config = await fs.readFile(state.configPath);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const installRoot = state.path("install");
      await fs.mkdir(installRoot);
      const baseline = await createUpdateRecoveryBackup({
        ...authority,
        installRoot,
        runId: run.runId,
      });
      const candidate = await preserveUpdateRecoveryCandidate(baseline, authority);
      const prepared =
        mode === "candidate"
          ? undefined
          : await prepareUpdateRecoveryGeneration(baseline, candidate, authority);
      const manifest = await verifyUpdateRecoveryBackup(candidate);
      const capturedFile = manifest.entries.find((entry) => entry.kind === "file");
      if (capturedFile?.kind !== "file") {
        throw new Error("Missing retained payload");
      }
      const payload = path.join(candidate.directory, capturedFile.archivePath);
      const payloadBefore = await fs.readFile(payload);
      // Pending generations are never cleanup candidates.
      await expect(retireUpdateRecoveryBackup(baseline, authority)).rejects.toThrow(
        /terminal outcome/,
      );
      await writeUpdateRecoveryBackupOutcome(baseline, { status: "committed" }, authority);
      if (mode === "baseline missing" || mode === "baseline changed") {
        const original = await verifyUpdateRecoveryBackup(baseline);
        const file = original.entries.find((entry) => entry.kind === "file");
        if (file?.kind !== "file" || !prepared) {
          throw new Error("Missing baseline/prepared fixture");
        }
        const pathname = path.join(baseline.directory, file.archivePath);
        if (mode === "baseline missing") {
          await fs.unlink(pathname);
        } else {
          await fs.appendFile(pathname, "changed before retirement");
        }
        await expect(retireUpdateRecoveryBackup(baseline, authority)).rejects.toThrow();
        expect(getUpdateRun(run.runId)?.origin.updateRecoveryCapture?.retirement).toBeUndefined();
        expect(await fs.readFile(payload)).toEqual(payloadBefore);
        await verifyUpdateRecoveryBackup(candidate);
        await verifyUpdateRecoveryBackup(prepared);
      } else if (mode === "binding") {
        const value = JSON.parse(await fs.readFile(candidate.manifestPath, "utf8"));
        value.generation.baselineSha256 = "0".repeat(64);
        await fs.writeFile(candidate.manifestPath, JSON.stringify(value));
        await expect(retireUpdateRecoveryBackup(baseline, authority)).rejects.toThrow(
          /does not belong to its retained baseline/,
        );
      } else if (mode === "foreign") {
        await fs.writeFile(
          path.join(candidate.directory, "operator-note"),
          "retained user evidence",
        );
        await expect(retireUpdateRecoveryBackup(baseline, authority)).rejects.toThrow(/unowned/);
      } else {
        if (mode === "interrupted") {
          if (!prepared) {
            throw new Error("Missing prepared fixture");
          }
          const preparedManifest = await verifyUpdateRecoveryBackup(prepared);
          const first = preparedManifest.entries.find((entry) => entry.kind === "file");
          if (first?.kind !== "file") {
            throw new Error("Missing prepared payload");
          }
          const firstPath = path.join(prepared.directory, first.archivePath);
          await expect(
            retireUpdateRecoveryBackup(baseline, {
              assertOwned() {
                if (!fsSync.existsSync(firstPath)) {
                  throw new Error("terminal owner interrupted after payload deletion");
                }
              },
            }),
          ).rejects.toThrow(/terminal owner interrupted/);
          expect(fsSync.existsSync(firstPath)).toBe(false);
          expect(await fs.readFile(payload)).toEqual(payloadBefore);
        }
        await retireUpdateRecoveryBackup(baseline, authority);
        await expect(fs.lstat(baseline.directory)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (mode === "binding" || mode === "foreign") {
        expect(await fs.readFile(payload)).toEqual(payloadBefore);
        await verifyUpdateRecoveryBackup(baseline);
      }
      expect(await fs.readFile(state.configPath)).toEqual(config);
    });
  });
  it.each(["untracked", "authored"] as const)(
    "seals and reuses T with %s config, preserving newer delivery writes and deletions",
    async (configChange) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const coordinator = state.path("coordinator");
        await fs.mkdir(coordinator);
        temporaryRoot.mockReturnValue(coordinator);
        await state.writeConfig({
          agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
          plugins: { enabled: false },
        });
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        closeOpenClawStateDatabaseForTest();
        const sharedPath = state.statePath("state", "openclaw.sqlite");
        const db = new (requireNodeSqlite().DatabaseSync)(sharedPath);
        db.exec(`INSERT INTO delivery_queue_entries(queue_name,id,status,entry_json,enqueued_at,updated_at)
        VALUES ('test','acknowledged','pending','{}',1,1);
        INSERT INTO state_leases(scope,lease_key,owner,created_at,updated_at)
          VALUES ('fixture','copied','baseline-owner',1,1);
        INSERT INTO agent_database_leases(lease_id,agent_id,path,owner_pid,opened_at)
          VALUES ('copied-agent','main','fixture-agent.sqlite',1,1)`);
        db.close();
        const installRoot = state.path("install");
        await fs.mkdir(installRoot);
        const baseline = await createUpdateRecoveryBackup({
          ...authority,
          installRoot,
          runId: run.runId,
        });
        const beforeManifest = await fs.readFile(baseline.manifestPath);
        closeOpenClawStateDatabaseForTest();
        const writer = new (requireNodeSqlite().DatabaseSync)(sharedPath);
        writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        DELETE FROM delivery_queue_entries WHERE id='acknowledged';
        INSERT INTO delivery_queue_entries(queue_name,id,status,entry_json,enqueued_at,updated_at)
          VALUES ('test','new-user-row','pending','{"current":true}',2,2);
        UPDATE state_leases SET owner='candidate-owner' WHERE scope='fixture';
        UPDATE agent_database_leases SET owner_pid=2 WHERE lease_id='copied-agent'`);
        const originalConfig = await fs.readFile(state.configPath, "utf8");
        const authoredConfig = `// retained user comment\n${originalConfig}`;
        await fs.writeFile(state.configPath, authoredConfig);
        let candidate;
        try {
          candidate = await withUpdateRecoveryConfigWrites(baseline, authority, async () => {
            if (configChange === "authored") {
              recordConfigFileWrite(
                state.configPath,
                createHash("sha256").update(originalConfig).digest("hex"),
                createHash("sha256").update(authoredConfig).digest("hex"),
              );
            }
            return await preserveUpdateRecoveryCandidate(baseline, authority);
          });
        } finally {
          writer.close();
        }
        const candidateManifest = await fs.readFile(candidate.manifestPath);
        const prepared = await prepareUpdateRecoveryGeneration(baseline, candidate, authority);
        const manifest = await verifyUpdateRecoveryBackup(prepared);
        expect(manifest.generation).toEqual({
          kind: "prepared",
          baselineSha256: baseline.manifestSha256,
          candidateSha256: candidate.manifestSha256,
        });
        const shared = manifest.entries.find((entry) => entry.sourcePath === sharedPath);
        const config = manifest.entries.find((entry) => entry.sourcePath === state.configPath);
        if (shared?.kind !== "file" || config?.kind !== "file") {
          throw new Error("Prepared closure is missing its database/config payload");
        }
        const restored = new (requireNodeSqlite().DatabaseSync)(
          resolveImmutableSqliteFileUri(path.join(prepared.directory, shared.archivePath)),
          { readOnly: true },
        );
        try {
          expect(restored.prepare("SELECT * FROM state_leases").all()).toEqual([]);
          expect(restored.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
          expect(
            restored.prepare("SELECT id,entry_json FROM delivery_queue_entries").all(),
          ).toEqual([{ id: "new-user-row", entry_json: '{"current":true}' }]);
        } finally {
          restored.close();
        }
        expect(await fs.readFile(path.join(prepared.directory, config.archivePath), "utf8")).toBe(
          configChange === "authored" ? originalConfig : authoredConfig,
        );
        const preparedBytes = await fs.readFile(prepared.manifestPath);
        expect(await prepareUpdateRecoveryGeneration(baseline, candidate, authority)).toEqual(
          prepared,
        );
        for (const [ref, owner, pid] of [
          [baseline, "baseline-owner", 1],
          [candidate, "candidate-owner", 2],
        ] as const) {
          const retained = await verifyUpdateRecoveryBackup(ref);
          const entry = retained.entries.find((item) => item.sourcePath === sharedPath);
          if (entry?.kind !== "file") {
            throw new Error("Retained generation lost the shared database");
          }
          const copy = new (requireNodeSqlite().DatabaseSync)(
            resolveImmutableSqliteFileUri(path.join(ref.directory, entry.archivePath)),
            { readOnly: true },
          );
          try {
            expect(
              copy.prepare("SELECT owner FROM state_leases WHERE scope='fixture'").get(),
            ).toEqual({ owner });
            expect(
              copy
                .prepare(
                  "SELECT owner_pid FROM agent_database_leases WHERE lease_id='copied-agent'",
                )
                .get(),
            ).toEqual({ owner_pid: pid });
          } finally {
            copy.close();
          }
        }
        const current = new (requireNodeSqlite().DatabaseSync)(sharedPath, { readOnly: true });
        try {
          expect(
            current.prepare("SELECT owner FROM state_leases WHERE scope='fixture'").get(),
          ).toEqual({ owner: "candidate-owner" });
          expect(
            current
              .prepare("SELECT owner_pid FROM agent_database_leases WHERE lease_id='copied-agent'")
              .get(),
          ).toEqual({ owner_pid: 2 });
        } finally {
          current.close();
        }
        expect(await fs.readFile(baseline.manifestPath)).toEqual(beforeManifest);
        expect(await fs.readFile(candidate.manifestPath)).toEqual(candidateManifest);
        expect(await fs.readFile(prepared.manifestPath)).toEqual(preparedBytes);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(authoredConfig);
      });
    },
  );
});
