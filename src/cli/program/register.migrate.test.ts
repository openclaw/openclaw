// Migrate CLI registration tests cover public option forwarding.
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

describe("registerMigrateCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.migrateApplyCommand.mockResolvedValue(undefined);
    mocks.migrateDefaultCommand.mockResolvedValue(undefined);
    mocks.migrateListCommand.mockResolvedValue(undefined);
    mocks.migratePlanCommand.mockResolvedValue(undefined);
  });

  it("forwards --agent through default, plan, and apply flows", async () => {
    await runCli(["migrate", "codex", "--agent", "research", "--item", "auth:openai", "--dry-run"]);
    expect(mocks.migrateDefaultCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ targetAgentId: "research", itemIds: ["auth:openai"] }),
    );

    await runCli(["migrate", "plan", "codex", "--agent", "research", "--item", "auth:openai"]);
    expect(mocks.migratePlanCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ targetAgentId: "research", itemIds: ["auth:openai"] }),
    );

    await runCli([
      "migrate",
      "apply",
      "codex",
      "--agent",
      "research",
      "--item",
      "auth:openai",
      "--yes",
    ]);
    expect(mocks.migrateApplyCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ targetAgentId: "research", itemIds: ["auth:openai"], yes: true }),
    );
  });

  it("keeps an explicit --no-auth-credentials opt-out placed before apply", async () => {
    await runCli(["migrate", "--no-auth-credentials", "apply", "hermes", "--yes"]);

    expect(mocks.migrateApplyCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ provider: "hermes", authCredentials: false, yes: true }),
    );
  });

  it("keeps an explicit --no-auth-credentials opt-out placed before plan", async () => {
    await runCli(["migrate", "--no-auth-credentials", "plan", "hermes"]);

    expect(mocks.migratePlanCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ provider: "hermes", authCredentials: false }),
    );
  });

  it("keeps auth credentials enabled when neither placement opts out", async () => {
    await runCli(["migrate", "apply", "hermes", "--yes"]);
    expect(mocks.migrateApplyCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ authCredentials: true }),
    );

    await runCli(["migrate", "plan", "hermes"]);
    expect(mocks.migratePlanCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ authCredentials: true }),
    );
  });

  it("honors --no-auth-credentials placed on the subcommand itself", async () => {
    await runCli(["migrate", "apply", "hermes", "--no-auth-credentials", "--yes"]);

    expect(mocks.migrateApplyCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ authCredentials: false }),
    );
  });

  it("inherits parent-placed --json into list", async () => {
    await runCli(["migrate", "--json", "list"]);
    expect(mocks.migrateListCommand).toHaveBeenCalledWith(mocks.runtime, { json: true });

    await runCli(["migrate", "list"]);
    expect(mocks.migrateListCommand).toHaveBeenLastCalledWith(mocks.runtime, { json: false });
  });

  it("inherits parent-placed selection and source options into plan", async () => {
    await runCli([
      "migrate",
      "--from",
      "/tmp/other-source",
      "--skill",
      "alpha",
      "--plugin",
      "beta",
      "--include-secrets",
      "--overwrite",
      "--json",
      "plan",
      "hermes",
    ]);

    expect(mocks.migratePlanCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({
        provider: "hermes",
        source: "/tmp/other-source",
        skills: ["alpha"],
        plugins: ["beta"],
        includeSecrets: true,
        overwrite: true,
        json: true,
      }),
    );
  });

  it("inherits parent-placed apply-only options", async () => {
    await runCli([
      "migrate",
      "--yes",
      "--no-backup",
      "--force",
      "--backup-output",
      "/tmp/backup.tgz",
      "apply",
      "hermes",
    ]);

    expect(mocks.migrateApplyCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({
        provider: "hermes",
        yes: true,
        noBackup: true,
        force: true,
        backupOutput: "/tmp/backup.tgz",
      }),
    );
  });

  it("keeps the pre-migration backup when neither placement passes --no-backup", async () => {
    await runCli(["migrate", "apply", "hermes", "--yes"]);

    expect(mocks.migrateApplyCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ noBackup: false }),
    );
  });

  it("honors --no-backup placed on the subcommand itself", async () => {
    await runCli(["migrate", "apply", "hermes", "--no-backup", "--force", "--yes"]);

    expect(mocks.migrateApplyCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ noBackup: true }),
    );
  });

  it("prefers subcommand placement over parent placement", async () => {
    await runCli([
      "migrate",
      "--from",
      "/tmp/parent-source",
      "--agent",
      "parent-agent",
      "--skill",
      "parent-skill",
      "--item",
      "auth:parent",
      "apply",
      "hermes",
      "--from",
      "/tmp/child-source",
      "--agent",
      "child-agent",
      "--skill",
      "child-skill",
      "--item",
      "auth:child",
      "--yes",
    ]);

    expect(mocks.migrateApplyCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({
        source: "/tmp/child-source",
        targetAgentId: "child-agent",
        skills: ["child-skill"],
        itemIds: ["auth:child"],
      }),
    );
  });

  it("rejects --dry-run placed before apply instead of silently applying", async () => {
    await runCli(["migrate", "--dry-run", "apply", "hermes", "--yes"]);

    expect(mocks.migrateApplyCommand).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--dry-run is not supported for `openclaw migrate apply`"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("still applies when --dry-run is absent", async () => {
    await runCli(["migrate", "apply", "hermes", "--yes"]);

    expect(mocks.migrateApplyCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });
});
