import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerMigrateCommand } from "./register.migrate.js";

const mocks = vi.hoisted(() => ({
  ExitError: class ExitError extends Error {},
  migrateApplyCommand: vi.fn(),
  migrateDefaultCommand: vi.fn(),
  migrateListCommand: vi.fn(),
  migratePlanCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/migrate.js", () => ({
  migrateApplyCommand: mocks.migrateApplyCommand,
  migrateDefaultCommand: mocks.migrateDefaultCommand,
  migrateListCommand: mocks.migrateListCommand,
  migratePlanCommand: mocks.migratePlanCommand,
}));

vi.mock("../../runtime.js", () => ({
  ExitError: mocks.ExitError,
  defaultRuntime: mocks.runtime,
}));

async function runCli(args: string[]): Promise<void> {
  const program = new OpenClawCommand();
  program.enablePositionalOptions();
  registerMigrateCommand(program);
  await program.parseAsync(args, { from: "user" });
}

beforeEach(() => vi.resetAllMocks());

describe("registered migration routes", () => {
  it.each([
    {
      args: "codex --agent research --item auth:openai --dry-run",
      command: mocks.migrateDefaultCommand,
      options: { targetAgentId: "research", itemIds: ["auth:openai"], dryRun: true },
    },
    {
      args: "--from /tmp/source --skill alpha --plugin beta --include-secrets --overwrite --json --no-auth-credentials plan hermes",
      command: mocks.migratePlanCommand,
      options: {
        provider: "hermes",
        source: "/tmp/source",
        skills: ["alpha"],
        plugins: ["beta"],
        includeSecrets: true,
        overwrite: true,
        json: true,
        authCredentials: false,
      },
    },
    {
      args: "--yes --no-backup --force --backup-output /tmp/backup.tgz --no-auth-credentials apply hermes",
      command: mocks.migrateApplyCommand,
      options: {
        provider: "hermes",
        yes: true,
        noBackup: true,
        force: true,
        backupOutput: "/tmp/backup.tgz",
        authCredentials: false,
      },
    },
    {
      args: "apply hermes --yes",
      command: mocks.migrateApplyCommand,
      options: { noBackup: false, authCredentials: true },
    },
    {
      args: "--from /tmp/parent --agent parent --skill parent --item auth:parent apply hermes --from /tmp/child --agent child --skill child --item auth:child --no-backup --no-auth-credentials --force --yes",
      command: mocks.migrateApplyCommand,
      options: {
        source: "/tmp/child",
        targetAgentId: "child",
        skills: ["child"],
        itemIds: ["auth:child"],
        noBackup: true,
        authCredentials: false,
      },
    },
  ])("resolves migration options for $args", async ({ args, command, options }) => {
    await runCli(["migrate", ...args.split(" ")]);
    expect(command).toHaveBeenCalledExactlyOnceWith(
      mocks.runtime,
      expect.objectContaining(options),
    );
  });

  it("inherits parent JSON into list", async () => {
    await runCli(["migrate", "--json", "list"]);
    expect(mocks.migrateListCommand).toHaveBeenCalledExactlyOnceWith(mocks.runtime, { json: true });
  });

  it("rejects a parent dry-run before apply can mutate", async () => {
    await runCli("migrate --dry-run apply hermes --yes".split(" "));
    expect(mocks.migrateApplyCommand).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--dry-run is not supported for `openclaw migrate apply`"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
