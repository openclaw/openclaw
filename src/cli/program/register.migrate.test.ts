import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerMigrateCommand } from "./register.migrate.js";

const commands = vi.hoisted(() => ({
  migrateApplyCommand: vi.fn(),
  migrateDefaultCommand: vi.fn(),
  migrateListCommand: vi.fn(),
  migratePlanCommand: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }));
// mock-isolation: route parsing must not import credentials or mutate real migration state.
vi.mock("../../commands/migrate.js", () => commands);

// mock-isolation: capture command exits without terminating the test worker.
vi.mock("../../runtime.js", () => ({
  ExitError: class ExitError extends Error {},
  defaultRuntime: runtime,
}));

async function runCli(args: string): Promise<void> {
  const program = new OpenClawCommand();
  program.enablePositionalOptions();
  registerMigrateCommand(program);
  await program.parseAsync(["migrate", ...args.split(" ")], { from: "user" });
}

beforeEach(() => vi.resetAllMocks());

describe("registered migration routes", () => {
  it.each([
    {
      args: "codex --agent research --item auth:openai --dry-run",
      command: commands.migrateDefaultCommand,
      options: { targetAgentId: "research", itemIds: ["auth:openai"], dryRun: true },
    },
    {
      args: "--from /tmp/source --skill alpha --plugin beta --include-secrets --overwrite --json --no-auth-credentials plan hermes",
      command: commands.migratePlanCommand,
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
      command: commands.migrateApplyCommand,
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
      command: commands.migrateApplyCommand,
      options: { noBackup: false, authCredentials: true },
    },
    {
      args: "--from /tmp/parent --agent parent --skill parent --item auth:parent apply hermes --from /tmp/child --agent child --skill child --item auth:child --no-backup --no-auth-credentials --force --yes",
      command: commands.migrateApplyCommand,
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
    await runCli(args);
    expect(command).toHaveBeenCalledExactlyOnceWith(runtime, expect.objectContaining(options));
  });

  it("inherits parent JSON into list", async () => {
    await runCli("--json list");
    expect(commands.migrateListCommand).toHaveBeenCalledExactlyOnceWith(runtime, { json: true });
  });

  it("rejects a parent dry-run before apply can mutate", async () => {
    await runCli("--dry-run apply hermes --yes");
    expect(commands.migrateApplyCommand).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--dry-run is not supported for `openclaw migrate apply`"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
