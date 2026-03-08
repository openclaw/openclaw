import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const backupCreateCommand = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand,
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
  });

  it("runs backup create with forwarded options", async () => {
    await runCli(["backup", "create", "--output", "/tmp/backups", "--json", "--dry-run"]);

    expect(backupCreateCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        output: "/tmp/backups",
        json: true,
        dryRun: true,
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
});
