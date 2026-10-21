import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import * as doctor from "../../flows/doctor-health.js";
import * as jsonFiles from "../../infra/json-files.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  updateFinishCommand,
  updateMigrateCommand,
  updateRestoreCommand,
} from "./update-command-migrate.js";

afterEach(() => vi.restoreAllMocks());

const readText = (file: string) => fs.readFile(file, "utf8");

it.each(["restored", "failed", "finished", "retried", "absent", "symlink", "unchanged"] as const)(
  "settles native migration recovery as %s",
  async (outcome) => {
    const fail = outcome === "failed";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const shared = openOpenClawStateDatabase({ env: state.env });
      const agentPath = path.join(state.agentDir(), "openclaw-agent.sqlite");
      const agent = openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env: state.env });
      agent.db.exec(
        "CREATE TABLE update_witness(value TEXT); INSERT INTO update_witness VALUES ('before');",
      );
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      await closeOpenClawStateDatabaseAsync();
      const included = path.join(state.stateDir, "settings.json");
      const original = '{ "$include": "settings.json" }\n';
      const originalIncluded = '{ "gateway": { "mode": "local" } }\n';
      await fs.writeFile(state.configPath, original);
      await fs.writeFile(included, originalIncluded);
      const includeTarget = path.join(state.stateDir, "settings-target.json");
      if (outcome === "symlink") {
        await fs.rename(included, includeTarget);
        await fs.symlink(includeTarget, included);
      }
      const originalIncludeIdentity = await fs.stat(included);
      if (outcome === "absent") {
        await fs.rm(state.configPath);
      }
      let backupRoot = state.path("update-recovery", "native");
      if (outcome === "restored") {
        const alias = state.path("recovery-link");
        await fs.mkdir(path.dirname(backupRoot));
        await fs.symlink(path.dirname(backupRoot), alias, "junction");
        backupRoot = path.join(alias, "native");
      }
      const receiptPath = `${backupRoot}.receipt.json`;
      const readReceipt = async () => JSON.parse(await readText(receiptPath));
      const restore = () => updateRestoreCommand(backupRoot);
      const runDoctor = vi
        .spyOn(doctor, "runDoctorHealthFlow")
        .mockImplementation(async (_runtime, _options, _authority, preflight) => {
          const receipt = await readReceipt();
          expect(receipt.status).toBe("backed-up");
          const [agentIdentity, sharedIdentity] = await Promise.all([
            fs.stat(agentPath, { bigint: true }),
            fs.stat(shared.path, { bigint: true }),
          ]);
          for (const [file, identity, owner] of [
            [agentPath, agentIdentity, { role: "agent", agentId: "main" }],
            [shared.path, sharedIdentity, { role: "global" }],
          ] as const) {
            expect(preflight?.verifiedSnapshots).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  sourcePath: file,
                  ...owner,
                  dev: identity.dev,
                  ino: identity.ino,
                }),
              ]),
            );
            expect(receipt.databaseIdentities[file]).toEqual({
              dev: Number(identity.dev),
              ino: Number(identity.ino),
            });
          }
          using database = new DatabaseSync(agentPath);
          database.exec("UPDATE update_witness SET value='candidate';");
          await fs.writeFile(state.configPath, '{"gateway":{"mode":"local"}}\n');
          if (outcome !== "absent" && outcome !== "unchanged") {
            await fs.writeFile(included, "{}\n");
          }
          if (fail) {
            throw new Error("synthetic Doctor failure");
          }
        });
      if (fail) {
        await expect(updateMigrateCommand(backupRoot)).rejects.toThrow("synthetic Doctor failure");
      } else {
        await updateMigrateCommand(backupRoot);
      }
      expect(runDoctor).toHaveBeenCalledOnce();
      expect((await readReceipt()).status).toBe(fail ? "failed" : "migrated");
      if (outcome === "finished") {
        await updateFinishCommand(backupRoot);
        const receipt = await readReceipt();
        expect(receipt).toMatchObject({ status: "finished", configFiles: [] });
        await expect(fs.stat(receipt.backup.directory)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(restore()).rejects.toThrow("rollback backup has been retired");
        return;
      }
      if (outcome === "retried") {
        const write = jsonFiles.writeTextAtomic;
        let interrupted = false;
        vi.spyOn(jsonFiles, "writeTextAtomic").mockImplementation(async (...args) => {
          if (args[0] === included && !interrupted) {
            interrupted = true;
            throw new Error("synthetic include restoration failure");
          }
          return write(...args);
        });
        await expect(restore()).rejects.toThrow("synthetic include restoration failure");
        expect((await readReceipt()).status).toBe("restoring-config");
        const later = '{"gateway":{"mode":"local","port":19999}}\n';
        await fs.writeFile(state.configPath, later);
        await expect(restore()).rejects.toThrow("newer bytes were preserved");
        expect(await readText(state.configPath)).toBe(later);
        await fs.writeFile(state.configPath, original);
      }
      await restore();
      const receipt = await readReceipt();
      expect(receipt.status).toBe("restored");
      if (outcome === "absent") {
        await expect(fs.stat(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(receipt.configIdentity).toBeNull();
      } else {
        expect(await readText(state.configPath)).toBe(original);
        expect(receipt.configIdentity.ino).toBe((await fs.stat(state.configPath)).ino);
      }
      expect(await readText(included)).toBe(originalIncluded);
      if (outcome === "symlink") {
        expect((await fs.lstat(included)).isSymbolicLink()).toBe(true);
        expect(await readText(includeTarget)).toBe(originalIncluded);
      }
      if (outcome === "unchanged") {
        expect((await fs.stat(included)).ino).toBe(originalIncludeIdentity.ino);
      }
      const displaced = (
        outcome === "absent" || outcome === "unchanged"
          ? [state.configPath]
          : [state.configPath, outcome === "symlink" ? includeTarget : included]
      ).map((file) => `${file}.migrated-${receipt.runId}`);
      expect(receipt.displacedConfigFiles).toEqual(displaced);
      expect(await readText(displaced[0]!)).toBe('{"gateway":{"mode":"local"}}\n');
      if (outcome !== "absent" && outcome !== "unchanged") {
        expect(await readText(displaced[1]!)).toBe("{}\n");
      }
      using restored = new DatabaseSync(agentPath, { readOnly: true });
      expect(restored.prepare("SELECT value FROM update_witness").get()?.value).toBe("before");
      expect(receipt.databaseIdentities[agentPath].ino).toBe((await fs.stat(agentPath)).ino);
    });
  },
);

it("refuses a future database before capture or Doctor mutation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentPath = path.join(state.agentDir(), "openclaw-agent.sqlite");
    const agent = openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env: state.env });
    agent.db.exec("PRAGMA user_version=999;");
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    const doctorRun = vi.spyOn(doctor, "runDoctorHealthFlow");
    const backupRoot = state.path("future-recovery");
    await expect(updateMigrateCommand(backupRoot)).rejects.toThrow("schema 999");
    expect(doctorRun).not.toHaveBeenCalled();
    await expect(fs.stat(`${backupRoot}.receipt.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
