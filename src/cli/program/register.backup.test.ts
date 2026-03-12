import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const backupCreateCommand = vi.fn();
const backupListCommand = vi.fn();
const backupRunCommand = vi.fn();
const backupStatusCommand = vi.fn();
const backupRestoreCommand = vi.fn();
const backupVerifyCommand = vi.fn();
const workspaceBackupInitCommand = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand,
}));

vi.mock("../../commands/backup-list.js", () => ({
  backupListCommand,
}));

vi.mock("../../commands/backup-run.js", () => ({
  backupRunCommand,
}));

vi.mock("../../commands/backup-status.js", () => ({
  backupStatusCommand,
}));

vi.mock("../../commands/workspace-backup.js", () => ({
  workspaceBackupInitCommand,
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
    backupRunCommand.mockResolvedValue(undefined);
    backupStatusCommand.mockResolvedValue(undefined);
    backupRestoreCommand.mockResolvedValue(undefined);
    backupVerifyCommand.mockResolvedValue(undefined);
    workspaceBackupInitCommand.mockResolvedValue(undefined);
  });

  it("runs backup setup with forwarded options", async () => {
    await runCli(["backup", "setup", "--target", "/tmp/backups", "--json"]);

    expect(workspaceBackupInitCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        target: "/tmp/backups",
        json: true,
      }),
    );
  });

  it("runs backup export with forwarded options", async () => {
    await runCli(["backup", "export", "--output", "/tmp/backups", "--json", "--dry-run"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        output: "/tmp/backups",
        json: true,
        dryRun: true,
        verify: false,
        onlyConfig: false,
        includeWorkspace: true,
      }),
    );
  });

  it("keeps backup create as an alias for backup export", async () => {
    await runCli(["backup", "create", "--output", "/tmp/backups"]);

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("`backup create` is deprecated; use `backup export`."),
    );
    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        output: "/tmp/backups",
      }),
    );
  });

  it("keeps backup create --json machine-readable by suppressing the deprecation banner", async () => {
    await runCli(["backup", "create", "--json"]);

    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("`backup create` is deprecated; use `backup export`."),
    );
    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        json: true,
      }),
    );
  });

  it("honors --no-include-workspace", async () => {
    await runCli(["backup", "export", "--no-include-workspace"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        includeWorkspace: false,
      }),
    );
  });

  it("forwards --verify to backup create", async () => {
    await runCli(["backup", "export", "--verify"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        verify: true,
      }),
    );
  });

  it("forwards --only-config to backup create", async () => {
    await runCli(["backup", "export", "--only-config"]);

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

  it("runs backup run with forwarded options", async () => {
    await runCli([
      "backup",
      "run",
      "--output",
      "/tmp/backups",
      "--verify",
      "--snapshot-name",
      "nightly",
    ]);

    expect(backupRunCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        output: "/tmp/backups",
        verify: true,
        snapshotName: "nightly",
      }),
    );
  });

  it("keeps backup push as a legacy alias with snapshot mode", async () => {
    await runCli([
      "backup",
      "push",
      "--output",
      "/tmp/backups",
      "--verify",
      "--snapshot-name",
      "nightly",
    ]);

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("`backup push` is deprecated; use `backup run`."),
    );
    expect(backupRunCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        output: "/tmp/backups",
        verify: true,
        snapshotName: "nightly",
        mode: "snapshot",
      }),
    );
  });

  it("keeps backup push --json machine-readable by suppressing the deprecation banner", async () => {
    await runCli(["backup", "push", "--json"]);

    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("`backup push` is deprecated; use `backup run`."),
    );
    expect(backupRunCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        json: true,
        mode: "snapshot",
      }),
    );
  });

  it("runs backup status with forwarded options", async () => {
    await runCli(["backup", "status", "--json"]);

    expect(backupStatusCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        json: true,
      }),
    );
  });

  it("runs backup list with forwarded options", async () => {
    await runCli(["backup", "list", "--json"]);

    expect(backupListCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        json: true,
      }),
    );
  });

  it("runs backup restore with forwarded options", async () => {
    await runCli([
      "backup",
      "restore",
      "snap_test",
      "--installation-id",
      "inst_123",
      "--mode",
      "workspace-only",
      "--force-stop",
      "--json",
    ]);

    expect(backupRestoreCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        snapshotId: "snap_test",
        installationId: "inst_123",
        mode: "workspace-only",
        forceStop: true,
        json: true,
      }),
    );
  });
});
