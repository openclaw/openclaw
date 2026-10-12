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
      const runDoctor = vi
        .spyOn(doctor, "runDoctorHealthFlow")
        .mockImplementation(async (_runtime, _options, _authority, preflight) => {
          const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
          expect(receipt.status).toBe("backed-up");
          expect(preflight?.verifiedSnapshots).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ sourcePath: agentPath, role: "agent", agentId: "main" }),
              expect.objectContaining({ sourcePath: shared.path, role: "global" }),
            ]),
          );
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
      expect(JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe(
        fail ? "failed" : "migrated",
      );
      if (outcome === "finished") {
        await updateFinishCommand(backupRoot);
        const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
        expect(receipt.status).toBe("finished");
        expect(receipt.configFiles).toEqual([]);
        await expect(fs.stat(receipt.backup.directory)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(updateRestoreCommand(backupRoot)).rejects.toThrow(
          "rollback backup has been retired",
        );
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
        await expect(updateRestoreCommand(backupRoot)).rejects.toThrow(
          "synthetic include restoration failure",
        );
        expect(JSON.parse(await fs.readFile(receiptPath, "utf8")).status).toBe("restoring-config");
        const later = '{"gateway":{"mode":"local","port":19999}}\n';
        await fs.writeFile(state.configPath, later);
        await expect(updateRestoreCommand(backupRoot)).rejects.toThrow(
          "newer bytes were preserved",
        );
        expect(await fs.readFile(state.configPath, "utf8")).toBe(later);
        await fs.writeFile(state.configPath, original);
      }
      await updateRestoreCommand(backupRoot);
      const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      expect(receipt.status).toBe("restored");
      if (outcome === "absent") {
        await expect(fs.stat(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(receipt.configIdentity).toBeNull();
      } else {
        expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
        expect(receipt.configIdentity.ino).toBe((await fs.stat(state.configPath)).ino);
      }
      expect(await fs.readFile(included, "utf8")).toBe(originalIncluded);
      if (outcome === "symlink") {
        expect((await fs.lstat(included)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(includeTarget, "utf8")).toBe(originalIncluded);
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
      expect(await fs.readFile(displaced[0]!, "utf8")).toBe('{"gateway":{"mode":"local"}}\n');
      if (outcome !== "absent" && outcome !== "unchanged") {
        expect(await fs.readFile(displaced[1]!, "utf8")).toBe("{}\n");
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
