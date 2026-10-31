import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";

it.each(["invalid-json", "hash-mismatch", "read-error", "staging-open"] as const)(
  "removes private restore staging after %s failure",
  async (failure) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-backup-failure-"));
    const sourcePath = path.join(root, "source.sqlite");
    const outputPath = path.join(root, "dump");
    const targetPath = path.join(root, "restored.sqlite");
    try {
      const database = openOpenClawStateDatabase({ path: sourcePath }).db;
      database.exec("CREATE TABLE content (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
      database.prepare("INSERT INTO content VALUES (?, ?)").run(1, "original");
      closeOpenClawStateDatabaseForTest();
      const manifest = await dumpGitBackupDatabase({
        snapshotPath: sourcePath,
        outputPath,
        identity: { role: "global" },
      });
      const tablePath = path.join(outputPath, "tables", "content.jsonl");
      if (failure === "staging-open") {
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          if (String(args[0]).includes(".git-backup-restore-")) {
            throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
          }
          return await open(...args);
        });
      } else if (failure === "read-error") {
        await fs.rm(tablePath);
        await fs.mkdir(tablePath);
      } else {
        const content = failure === "invalid-json" ? "not JSON\n" : '{"id":1,"body":"changed"}\n';
        await fs.writeFile(tablePath, content);
        if (failure === "invalid-json") {
          manifest.tables.content = {
            rows: 1,
            sha256: createHash("sha256").update(content).digest("hex"),
          };
          await fs.writeFile(path.join(outputPath, "manifest.json"), JSON.stringify(manifest));
        }
      }
      await expect(
        restoreGitBackupDirectory({ sourcePath: outputPath, targetPath }),
      ).rejects.toThrow();
      await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(root)).filter((name) => name.startsWith(".git-backup-restore-")),
      ).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
