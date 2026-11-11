import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as spawn from "../process/exec-spawn.js";
import * as command from "../process/exec.js";
import { createGitBackup, restoreGitBackupRef } from "./git-backup.js";
import { createStateDatabaseFixture, withBackupStateEnv } from "./git-backup.test-support.js";
import { withDatabase } from "./local-repository.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const workloads = [
  { bytes: 1, duration: 119_000, deadline: 120_000 },
  { bytes: 256 * 1024 ** 2, duration: 130_000, deadline: 300_000 },
  { bytes: 100 * 1024 ** 3, duration: 86_400_000, deadline: 86_400_000 },
];

it.each(workloads)(
  "commits a $bytes-byte refresh within a bounded content budget",
  async ({ bytes, duration, deadline }) => {
    const root = roots.make("git-backup-budget-");
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    await withBackupStateEnv({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const backup = { repositoryPath, stateDir, databases: [database] };
      const initial = await createGitBackup(backup);
      withDatabase(database.path, (source) => source.exec("CREATE TABLE new_content (id INTEGER)"));
      // Exercise real pruning as well as content staging; the pruned files have no size.
      const manifestPath = path.join(repositoryPath, "global", "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      manifest.tables.retired = { rows: 0, sha256: "0".repeat(64) };
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      await fs.writeFile(path.join(repositoryPath, "global", "tables", "retired.jsonl"), "");
      await fs.writeFile(path.join(repositoryPath, "operator.txt"), "keep me");
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        // Model large serialized artifacts without allocating gigabytes on CI workers.
        if (String(args[0]).endsWith(`${path.sep}schema.sql`)) {
          Object.defineProperty(stat, "size", { value: bytes });
        }
        return stat;
      });
      const run = command.runCommandWithTimeout;
      vi.spyOn(command, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        // Fixed external I/O latency: exercise the Git error boundary without a real sleep.
        if (argv.includes("update-index") && typeof options !== "number") {
          const budget = options.timeoutMs ?? 0;
          if (budget < duration || budget > deadline) {
            return {
              stdout: "",
              stderr: "slow artifact hashing",
              code: null,
              signal: "SIGTERM",
              killed: true,
              termination: "timeout",
            };
          }
        }
        return await run(argv, options);
      });
      const refreshed = await createGitBackup(backup);
      expect(refreshed.commit).toBeTruthy();
      expect(refreshed.commit).not.toBe(initial.commit);
      expect(await fs.readFile(path.join(repositoryPath, "operator.txt"), "utf8")).toBe("keep me");
      await expect(
        fs.lstat(path.join(repositoryPath, "global", "tables", "retired.jsonl")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

it.each(workloads)(
  "restores a $bytes-byte blob from its committed size within a bounded budget",
  async ({ bytes, duration, deadline }) => {
    const root = roots.make("git-backup-budget-");
    const { stateDir, database } = createStateDatabaseFixture(root);
    const repositoryPath = path.join(root, "repository");
    await withBackupStateEnv({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const created = await createGitBackup({ repositoryPath, stateDir, databases: [database] });
      const run = command.runCommandWithTimeout;
      vi.spyOn(command, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
        const result = await run(argv, options);
        // Git's fixed metadata fixture reports a large schema blob at this ref.
        if (argv.includes("ls-tree")) {
          result.stdout = result.stdout.replace(
            /(100644 blob [a-f0-9]+ +)\d+(\tglobal\/schema.sql)/,
            (_entry, prefix, suffix) => `${prefix}${bytes}${suffix}`,
          );
        }
        return result;
      });
      const start = spawn.spawnCommand;
      vi.spyOn(spawn, "spawnCommand").mockImplementation((argv, options) => {
        if (argv.includes("show") && argv.some((arg) => arg.endsWith(":global/schema.sql"))) {
          const budget = typeof options?.timeout === "number" ? options.timeout : 0;
          if (budget < duration || budget > deadline) {
            throw new Error("slow Git blob materialization exceeded its deadline");
          }
        }
        return start(argv, options);
      });
      await fs.rm(path.join(repositoryPath, "global"), { recursive: true });
      const restored = await restoreGitBackupRef({
        repositoryPath,
        identity: database.identity,
        targetPath: path.join(root, "restored.sqlite"),
      });
      expect(restored.commit).toBe(created.commit);
      expect(restored.tables.every((table) => table.ok)).toBe(true);
    });
  },
);
