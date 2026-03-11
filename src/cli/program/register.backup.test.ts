import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const backupListCommand = vi.fn();
const backupCreateCommand = vi.fn();
const backupRestoreCommand = vi.fn();
const backupVerifyCommand = vi.fn();
const chooseBackupArchiveForRestore = vi.fn();
const resolveLatestBackupArchiveForRestore = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand,
}));

vi.mock("../../commands/backup-catalog.js", () => ({
  backupListCommand,
  chooseBackupArchiveForRestore,
  resolveLatestBackupArchiveForRestore,
}));

vi.mock("../../commands/backup-restore.js", () => ({
  backupRestoreCommand,
}));

vi.mock("../../commands/backup-verify.js", () => ({
  backupVerifyCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerBackupCommand: typeof import("./register.backup.js").registerBackupCommand;

beforeAll(async () => {
  ({ registerBackupCommand } = await import("./register.backup.js"));
});

describe("registerBackupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerBackupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    backupCreateCommand.mockResolvedValue(undefined);
    backupListCommand.mockResolvedValue(undefined);
    backupRestoreCommand.mockResolvedValue(undefined);
    backupVerifyCommand.mockResolvedValue(undefined);
    chooseBackupArchiveForRestore.mockResolvedValue("/tmp/chosen-openclaw-backup.tar.gz");
    resolveLatestBackupArchiveForRestore.mockResolvedValue("/tmp/latest-openclaw-backup.tar.gz");
  });

  it("runs backup create with forwarded options", async () => {
    await runCli(["backup", "create", "--output", "/tmp/backups", "--json", "--dry-run"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        output: "/tmp/backups",
        json: true,
        dryRun: true,
        verify: true,
        onlyConfig: false,
        includeWorkspace: true,
      }),
    );
  });

  it("honors --no-include-workspace", async () => {
    await runCli(["backup", "create", "--no-include-workspace"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        includeWorkspace: false,
      }),
    );
  });

  it("creates validated backups by default", async () => {
    await runCli(["backup", "create"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        dryRun: false,
        verify: true,
      }),
    );
  });

  it("forwards --only-config to backup create", async () => {
    await runCli(["backup", "create", "--only-config"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        onlyConfig: true,
      }),
    );
  });

  it("runs backup verify with forwarded options", async () => {
    await runCli(["backup", "verify", "/tmp/openclaw-backup.tar.gz", "--json"]);

    expect(backupVerifyCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        archive: "/tmp/openclaw-backup.tar.gz",
        json: true,
      }),
    );
  });

  it("runs backup list with forwarded options", async () => {
    await runCli(["backup", "list", "/tmp/backups", "--json"]);

    expect(backupListCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        path: "/tmp/backups",
        json: true,
      }),
    );
  });

  it("runs backup restore with forwarded options", async () => {
    await runCli([
      "backup",
      "restore",
      "/tmp/openclaw-backup.tar.gz",
      "--json",
      "--dry-run",
      "--force",
      "--no-include-workspace",
    ]);

    expect(backupRestoreCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        archive: "/tmp/openclaw-backup.tar.gz",
        json: true,
        dryRun: true,
        force: true,
        includeWorkspace: false,
      }),
    );
  });

  it("restores the latest validated backup by default", async () => {
    await runCli(["backup", "restore", "--dry-run"]);

    expect(resolveLatestBackupArchiveForRestore).toHaveBeenCalledWith({});
    expect(backupRestoreCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        archive: "/tmp/latest-openclaw-backup.tar.gz",
        dryRun: true,
      }),
    );
  });

  it("supports interactive restore version selection with --choose", async () => {
    await runCli(["backup", "restore", "--choose", "/tmp/backups", "--dry-run"]);

    expect(chooseBackupArchiveForRestore).toHaveBeenCalledWith({
      runtime,
      searchPath: "/tmp/backups",
    });
    expect(backupRestoreCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        archive: "/tmp/chosen-openclaw-backup.tar.gz",
        dryRun: true,
      }),
    );
  });
});
