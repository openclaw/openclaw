import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBackupCommand } from "./register.backup.js";

const mocks = vi.hoisted(() => ({
  backupCreateCommand: vi.fn(),
  backupGitLogCommand: vi.fn(),
  backupRestoreCommand: vi.fn(),
  backupSqliteCreateCommand: vi.fn(),
  backupSqliteListCommand: vi.fn(),
  backupSqliteRestoreCommand: vi.fn(),
  backupSqliteVerifyCommand: vi.fn(),
  backupVerifyCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand: mocks.backupCreateCommand,
}));

vi.mock("../../commands/backup-git.js", () => ({
  backupGitLogCommand: mocks.backupGitLogCommand,
}));

vi.mock("../../commands/backup-restore.js", () => ({
  backupRestoreCommand: mocks.backupRestoreCommand,
}));

vi.mock("../../commands/backup-verify.js", () => ({
  backupVerifyCommand: mocks.backupVerifyCommand,
}));

vi.mock("../../commands/backup-sqlite.js", () => ({
  backupSqliteCreateCommand: mocks.backupSqliteCreateCommand,
  backupSqliteListCommand: mocks.backupSqliteListCommand,
  backupSqliteRestoreCommand: mocks.backupSqliteRestoreCommand,
  backupSqliteVerifyCommand: mocks.backupSqliteVerifyCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

const { runtime } = mocks;
beforeEach(() => vi.resetAllMocks());

describe("registered backup routes", () => {
  it.each([
    {
      args: "create --output /tmp/backups --json --dry-run",
      command: mocks.backupCreateCommand,
      options: {
        output: "/tmp/backups",
        json: true,
        dryRun: true,
        verify: false,
        onlyConfig: false,
        includeWorkspace: true,
      },
    },
    {
      args: "verify /tmp/backup.tar.gz --json",
      command: mocks.backupVerifyCommand,
      options: { archive: "/tmp/backup.tar.gz", json: true },
    },
    {
      args: "restore /tmp/backup.tar.gz --target /tmp/restored --json",
      command: mocks.backupRestoreCommand,
      options: { archive: "/tmp/backup.tar.gz", target: "/tmp/restored", json: true },
    },
    {
      args: "sqlite create --global --repository /tmp/snapshots --json",
      command: mocks.backupSqliteCreateCommand,
      options: { global: true, agent: undefined, repository: "/tmp/snapshots", json: true },
    },
    {
      args: "sqlite list --repository /tmp/snapshots --json",
      command: mocks.backupSqliteListCommand,
      options: { repository: "/tmp/snapshots", json: true },
    },
  ])("dispatches backup $args", async ({ args, command, options }) => {
    const program = new Command();
    registerBackupCommand(program);
    await program.parseAsync(["backup", ...args.split(" ")], { from: "user" });
    expect(command).toHaveBeenCalledExactlyOnceWith(runtime, options);
  });

  it.each([
    {
      args: "verify /tmp/snapshots/one --scratch /tmp/scratch --json",
      command: mocks.backupSqliteVerifyCommand,
      options: { scratch: "/tmp/scratch", json: true },
    },
    {
      args: "restore /tmp/snapshots/one --target /tmp/restored.sqlite --json",
      command: mocks.backupSqliteRestoreCommand,
      options: { target: "/tmp/restored.sqlite", json: true },
    },
  ])("dispatches backup sqlite $args", async ({ args, command, options }) => {
    const program = new Command();
    registerBackupCommand(program);
    await program.parseAsync(["backup", "sqlite", ...args.split(" ")], { from: "user" });
    expect(command).toHaveBeenCalledExactlyOnceWith(runtime, "/tmp/snapshots/one", options);
  });

  it("rejects partial Git log limits before dispatch", async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerBackupCommand(program);
    await expect(
      program.parseAsync("backup git log --repository /tmp/backups --limit 1oops".split(" "), {
        from: "user",
      }),
    ).rejects.toThrow("--limit must be a positive integer.");
    expect(mocks.backupGitLogCommand).not.toHaveBeenCalled();
  });
});
