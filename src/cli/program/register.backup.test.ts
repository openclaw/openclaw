import { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const backupCreateCommand = vi.fn();
const backupVerifyCommand = vi.fn();

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand,
}));

vi.mock("../../commands/backup-verify.js", () => ({
  backupVerifyCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

const mockedModuleIds = [
  "../../commands/backup.js",
  "../../commands/backup-verify.js",
  "../../runtime.js",
];

let registerBackupCommand: typeof import("./register.backup.js").registerBackupCommand;

beforeAll(async () => {
  ({ registerBackupCommand } = await import("./register.backup.js"));
});

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
  vi.resetModules();
});

describe("registerBackupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerBackupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    backupCreateCommand.mockResolvedValue(undefined);
    backupVerifyCommand.mockResolvedValue(undefined);
  });

  it("runs backup create with forwarded options", async () => {
    await runCli(["backup", "create", "--output", "/tmp/backups", "--json", "--dry-run"]);

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

  it("honors --no-include-workspace", async () => {
    await runCli(["backup", "create", "--no-include-workspace"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        includeWorkspace: false,
      }),
    );
  });

  it("forwards --verify to backup create", async () => {
    await runCli(["backup", "create", "--verify"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
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
});
