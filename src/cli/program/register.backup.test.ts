import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { registerBackupCommand } from "./register.backup.js";

const handlers = vi.hoisted(() => ({
  create: vi.fn(),
  verify: vi.fn(),
  restore: vi.fn(),
  gitLog: vi.fn(),
  gitRestore: vi.fn(),
  gitVerify: vi.fn(),
  sqliteCreate: vi.fn(),
  sqliteList: vi.fn(),
  sqliteRestore: vi.fn(),
  sqliteVerify: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

// mock-isolation: argument parsing must not create real backup archives.
vi.mock("../../commands/backup.js", () => ({ backupCreateCommand: handlers.create }));
// Argument parsing must not open database owners or launch backup workers.
// mock-isolation: argument parsing must not open repositories or launch backup workers.
vi.mock("../../commands/backup-git.js", () => ({
  backupGitLogCommand: handlers.gitLog,
  backupGitRestoreCommand: handlers.gitRestore,
  backupGitVerifyCommand: handlers.gitVerify,
}));
// mock-isolation: argument parsing must not restore or overwrite operator data.
vi.mock("../../commands/backup-restore.js", () => ({ backupRestoreCommand: handlers.restore }));
// mock-isolation: argument parsing must not read real backup archives.
vi.mock("../../commands/backup-verify.js", () => ({ backupVerifyCommand: handlers.verify }));
// mock-isolation: argument parsing must not open database owners or backup workers.
vi.mock("../../commands/backup-sqlite.js", () => ({
  backupSqliteCreateCommand: handlers.sqliteCreate,
  backupSqliteListCommand: handlers.sqliteList,
  backupSqliteRestoreCommand: handlers.sqliteRestore,
  backupSqliteVerifyCommand: handlers.sqliteVerify,
}));
// mock-isolation: capture JSON and exit requests without writing to the real terminal or exiting.
vi.mock("../../runtime.js", () => ({ defaultRuntime: handlers.runtime }));

const { runtime } = handlers;
const gitOptions = { repository: "/repo", ref: "HEAD", global: false, json: true };
async function parse(args: string) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerBackupCommand(program);
  await program.parseAsync(["backup", ...args.split(" ")], { from: "user" });
}
beforeEach(() => vi.resetAllMocks());

it.each([
  [
    "create --output /repo --json --dry-run",
    handlers.create,
    {
      output: "/repo",
      json: true,
      dryRun: true,
      verify: false,
      onlyConfig: false,
      includeWorkspace: true,
    },
  ],
  ["verify /backup.tgz --json", handlers.verify, { archive: "/backup.tgz", json: true }],
  [
    "restore /backup.tgz --target /restored --json",
    handlers.restore,
    { archive: "/backup.tgz", target: "/restored", json: true },
  ],
  [
    "sqlite create --global --repository /repo --json",
    handlers.sqliteCreate,
    { global: true, agent: undefined, repository: "/repo", json: true },
  ],
  [
    "sqlite list --repository /repo --json",
    handlers.sqliteList,
    { repository: "/repo", json: true },
  ],
  [
    "git restore --repository /repo --store team-reports --target /restored.sqlite --json",
    handlers.gitRestore,
    { ...gitOptions, store: "team-reports", target: "/restored.sqlite" },
  ],
  [
    "git verify --repository /repo --store workboard --json",
    handlers.gitVerify,
    { ...gitOptions, store: "workboard" },
  ],
] as const)("dispatches backup %s", async (args, command, options) => {
  await parse(args);
  expect(command).toHaveBeenCalledExactlyOnceWith(runtime, options);
});

it.each([
  [
    "verify /snapshot --scratch /scratch --json",
    handlers.sqliteVerify,
    { scratch: "/scratch", json: true },
  ],
  [
    "restore /snapshot --target /restored.sqlite --json",
    handlers.sqliteRestore,
    { target: "/restored.sqlite", json: true },
  ],
] as const)("dispatches backup sqlite %s", async (args, command, options) => {
  await parse(`sqlite ${args}`);
  expect(command).toHaveBeenCalledExactlyOnceWith(runtime, "/snapshot", options);
});

it("rejects partial Git log limits before dispatch", async () => {
  await expect(parse("git log --repository /repo --limit 1oops")).rejects.toThrow(
    "--limit must be a positive integer.",
  );
  expect(handlers.gitLog).not.toHaveBeenCalled();
});
