import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const backupCreateCommand = vi.fn();
const backupVerifyCommand = vi.fn();
const callGatewayFromCli = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../commands/backup.js", () => ({
  backupCreateCommand,
}));

vi.mock("../../commands/backup-verify.js", () => ({
  backupVerifyCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("../gateway-rpc.js", () => ({
  addGatewayClientOptions: (cmd: Command) => cmd,
  callGatewayFromCli: (...args: unknown[]) => callGatewayFromCli(...args),
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
    backupVerifyCommand.mockResolvedValue(undefined);
    callGatewayFromCli.mockResolvedValue({});
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

  it("creates scheduled backup jobs through cron.add", async () => {
    await runCli(["backup", "schedule", "add", "--every", "24h", "--verify"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({
        every: "24h",
        verify: true,
      }),
      expect.objectContaining({
        name: "Scheduled backup",
        sessionTarget: "main",
        wakeMode: "now",
        schedule: {
          kind: "every",
          everyMs: 86_400_000,
        },
        payload: expect.objectContaining({
          kind: "backupCreate",
          output: "~/Backups/",
          verify: true,
          includeWorkspace: true,
        }),
      }),
    );
  });

  it("defaults scheduled backups to every 24h when no schedule flag is provided", async () => {
    await runCli(["backup", "schedule", "add"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.any(Object),
      expect.objectContaining({
        schedule: {
          kind: "every",
          everyMs: 86_400_000,
        },
      }),
    );
  });

  it("lists only scheduled backup jobs", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      jobs: [
        {
          id: "backup-job",
          name: "Scheduled backup",
          enabled: true,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "backupCreate" },
          state: {},
        },
        {
          id: "non-backup-job",
          name: "Other job",
          enabled: true,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      ],
    });

    await runCli(["backup", "schedule", "list", "--json"]);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining('"id": "backup-job"'));
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining('"id": "non-backup-job"'));
  });
});
