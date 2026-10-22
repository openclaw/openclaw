import "../../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawCommand } from "./openclaw-command.js";
import { registerAgentTurnCommand } from "./register.agent-turn.js";
import { registerAgentsCommands } from "./register.agent.js";
import { registerBackupCommand } from "./register.backup.js";
import { registerMigrateCommand } from "./register.migrate.js";

const mocks = vi.hoisted(() => ({
  agentCliCommandMock: vi.fn(),
  agentExecCommandMock: vi.fn(),
  agentsAddCommandMock: vi.fn(),
  agentsTeamCreateCommandMock: vi.fn(),
  agentsBindingsCommandMock: vi.fn(),
  agentsUpdateBindingsCommandMock: vi.fn(),
  agentsDeleteCommandMock: vi.fn(),
  agentsListCommandMock: vi.fn(),
  agentsSetIdentityCommandMock: vi.fn(),
  requestExitAfterOneShotOutputMock: vi.fn(),
  setVerboseMock: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../commands/agent-via-gateway.js", () => ({
  agentCliCommand: mocks.agentCliCommandMock,
}));

vi.mock("../../commands/agent-exec.js", () => ({
  agentExecCommand: mocks.agentExecCommandMock,
}));

vi.mock("../../commands/agents.commands.add.js", () => ({
  agentsAddCommand: mocks.agentsAddCommandMock,
}));

vi.mock("../../commands/agents.commands.team.js", () => ({
  agentsTeamCreateCommand: mocks.agentsTeamCreateCommandMock,
}));

vi.mock("../../commands/agents.commands.bind.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/agents.commands.bind.js")>()),
  agentsBindingsCommand: mocks.agentsBindingsCommandMock,
  agentsUpdateBindingsCommand: mocks.agentsUpdateBindingsCommandMock,
}));

vi.mock("../../commands/agents.commands.delete.js", () => ({
  agentsDeleteCommand: mocks.agentsDeleteCommandMock,
}));

vi.mock("../../commands/agents.commands.identity.js", () => ({
  agentsSetIdentityCommand: mocks.agentsSetIdentityCommandMock,
}));

vi.mock("../../commands/agents.commands.list.js", () => ({
  agentsListCommand: mocks.agentsListCommandMock,
}));

vi.mock("../../global-state.js", () => ({
  setVerbose: mocks.setVerboseMock,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

vi.mock("../one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: mocks.requestExitAfterOneShotOutputMock,
}));

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

const { agentCliCommandMock: agent, agentExecCommandMock: exec, runtime } = mocks;

async function runCli(args: string[]) {
  const program = new Command().enablePositionalOptions();
  registerAgentTurnCommand(program, { agentChannelOptions: "last|telegram|discord" });
  registerAgentsCommands(program);
  await program.parseAsync(args, { from: "user" });
}

beforeEach(() => {
  vi.resetAllMocks();
  exec.mockResolvedValue({ exitCode: 0 });
});

describe("agent command registration", () => {
  it("normalizes explicit verbosity", async () => {
    await runCli("agent --message hi --verbose ON --json".split(" "));
    expect(mocks.setVerboseMock).toHaveBeenCalledWith(true);
    expect(agent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "hi", verbose: "ON", json: true }),
      runtime,
    );
  });

  it("resolves parent and leaf exec options", async () => {
    const overrides = ['{"tools":{"deny":["exec"]}}', '{"tools":{"deny":[]}}'];
    await runCli([
      ..."agent --timeout 30 exec fix --timeout 120".split(" "),
      ...overrides.flatMap((value) => ["--config-override", value]),
    ]);
    expect(exec).toHaveBeenCalledWith(
      "fix",
      expect.objectContaining({
        timeout: "120",
        configOverride: overrides,
      }),
      runtime,
    );
    expect(agent).not.toHaveBeenCalled();
  });

  it("selects agent creation posture", async () => {
    await runCli(
      "agents add beta --workspace /tmp/ws --bind telegram --bind discord:acct --non-interactive --json".split(
        " ",
      ),
    );
    expect(mocks.agentsAddCommandMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "beta",
        workspace: "/tmp/ws",
        bind: ["telegram", "discord:acct"],
        nonInteractive: true,
        json: true,
      }),
      { hasAutomationFlags: true },
    );
  });

  it.each([
    ["", mocks.agentsListCommandMock, {}],
    [
      "list --json --bindings --tree",
      mocks.agentsListCommandMock,
      { json: true, bindings: true, tree: true },
    ],
    ["bindings --agent ops --json", mocks.agentsBindingsCommandMock, { agent: "ops", json: true }],
    [
      "bind --agent ops --bind matrix:ops --bind telegram --json",
      mocks.agentsUpdateBindingsCommandMock,
      { agent: "ops", bind: ["matrix:ops", "telegram"], json: true },
      "bind",
    ],
    [
      "unbind --agent ops --all --json",
      mocks.agentsUpdateBindingsCommandMock,
      { agent: "ops", bind: [], all: true, json: true },
      "unbind",
    ],
    [
      "delete worker-a --force --json",
      mocks.agentsDeleteCommandMock,
      { id: "worker-a", force: true, json: true },
    ],
    [
      "team create --preset team --coordinator lead --prefix docs --workspace-root /tmp/team --non-interactive --json",
      mocks.agentsTeamCreateCommandMock,
      {
        preset: "team",
        coordinator: "lead",
        prefix: "docs",
        workspaceRoot: "/tmp/team",
        nonInteractive: true,
        json: true,
      },
    ],
    [
      "set-identity --agent main --workspace /tmp/ws --identity-file /tmp/ws/IDENTITY.md --from-identity --json",
      mocks.agentsSetIdentityCommandMock,
      {
        agent: "main",
        workspace: "/tmp/ws",
        identityFile: "/tmp/ws/IDENTITY.md",
        fromIdentity: true,
        json: true,
      },
    ],
  ] as const)(
    "dispatches agents %s",
    async (args, command, options, operation?: "bind" | "unbind") => {
      await runCli(["agents", ...(args ? args.split(" ") : [])]);
      expect(command).toHaveBeenCalledExactlyOnceWith(...(operation ? [operation] : []), options);
    },
  );

  it("renders Gateway request failures without internal class names", async () => {
    const message =
      "The selected model was not found by the provider. Check the model id or choose a different model.";
    agent.mockRejectedValueOnce(
      Object.assign(new Error(message), {
        name: "GatewayClientRequestError",
        code: "UNAVAILABLE",
        gatewayCode: "UNAVAILABLE",
        details: { reason: "model_not_found" },
      }),
    );
    await runCli("agent --message hello --json".split(" "));
    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("Error:"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("backup registration", () => {
  const gitOptions = { repository: "/repo", ref: "HEAD", global: false, json: true };
  async function parse(args: string) {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerBackupCommand(program);
    await program.parseAsync(["backup", ...args.split(" ")], { from: "user" });
  }

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
});

const commands = vi.hoisted(() => ({
  migrateApplyCommand: vi.fn(),
  migrateDefaultCommand: vi.fn(),
  migrateListCommand: vi.fn(),
  migratePlanCommand: vi.fn(),
}));
// mock-isolation: route parsing must not import credentials or mutate real migration state.
vi.mock("../../commands/migrate.js", () => commands);

async function runMigrate(args: string): Promise<void> {
  const program = new OpenClawCommand();
  program.enablePositionalOptions();
  registerMigrateCommand(program);
  await program.parseAsync(["migrate", ...args.split(" ")], { from: "user" });
}

describe("registered migration routes", () => {
  it.each([
    [
      "codex --agent research --item auth:openai --dry-run",
      commands.migrateDefaultCommand,
      { targetAgentId: "research", itemIds: ["auth:openai"], dryRun: true },
    ],
    [
      "--from /tmp/source --skill alpha --plugin beta --include-secrets --overwrite --json --no-auth-credentials plan hermes",
      commands.migratePlanCommand,
      {
        provider: "hermes",
        source: "/tmp/source",
        skills: ["alpha"],
        plugins: ["beta"],
        includeSecrets: true,
        overwrite: true,
        json: true,
        authCredentials: false,
      },
    ],
    [
      "--yes --no-backup --force --backup-output /tmp/backup.tgz --no-auth-credentials apply hermes",
      commands.migrateApplyCommand,
      {
        provider: "hermes",
        yes: true,
        noBackup: true,
        force: true,
        backupOutput: "/tmp/backup.tgz",
        authCredentials: false,
      },
    ],
    [
      "apply hermes --yes",
      commands.migrateApplyCommand,
      { noBackup: false, authCredentials: true },
    ],
    [
      "--from /tmp/parent --agent parent --skill parent --item auth:parent apply hermes --from /tmp/child --agent child --skill child --item auth:child --no-backup --no-auth-credentials --force --yes",
      commands.migrateApplyCommand,
      {
        source: "/tmp/child",
        targetAgentId: "child",
        skills: ["child"],
        itemIds: ["auth:child"],
        noBackup: true,
        authCredentials: false,
      },
    ],
  ])("resolves migration options for %s", async (args, command, options) => {
    await runMigrate(args);
    expect(command).toHaveBeenCalledExactlyOnceWith(runtime, expect.objectContaining(options));
  });

  it("inherits parent JSON into list", async () => {
    await runMigrate("--json list");
    expect(commands.migrateListCommand).toHaveBeenCalledExactlyOnceWith(runtime, { json: true });
  });

  it("rejects a parent dry-run before apply can mutate", async () => {
    await runMigrate("--dry-run apply hermes --yes");
    expect(commands.migrateApplyCommand).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--dry-run is not supported for `openclaw migrate apply`"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
