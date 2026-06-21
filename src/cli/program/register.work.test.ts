// Register work command tests cover Beads command option forwarding.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkCommands } from "./register.work.js";

const mocks = vi.hoisted(() => ({
  workStatusCommand: vi.fn(),
  workReadyCommand: vi.fn(),
  workListCommand: vi.fn(),
  workCreateCommand: vi.fn(),
  workClaimCommand: vi.fn(),
  workShowCommand: vi.fn(),
  workCloseCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/work.js", () => ({
  workStatusCommand: mocks.workStatusCommand,
  workReadyCommand: mocks.workReadyCommand,
  workListCommand: mocks.workListCommand,
  workCreateCommand: mocks.workCreateCommand,
  workClaimCommand: mocks.workClaimCommand,
  workShowCommand: mocks.workShowCommand,
  workCloseCommand: mocks.workCloseCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerWorkCommands", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerWorkCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.exit.mockImplementation(() => {});
    mocks.workStatusCommand.mockResolvedValue(undefined);
    mocks.workReadyCommand.mockResolvedValue(undefined);
    mocks.workListCommand.mockResolvedValue(undefined);
    mocks.workCreateCommand.mockResolvedValue(undefined);
    mocks.workClaimCommand.mockResolvedValue(undefined);
    mocks.workShowCommand.mockResolvedValue(undefined);
    mocks.workCloseCommand.mockResolvedValue(undefined);
  });

  it("forwards ready filters to the work command", async () => {
    await runCli([
      "work",
      "ready",
      "--json",
      "--limit",
      "10",
      "--label",
      "openclaw",
      "--metadata",
      "repo=openclaw/openclaw",
    ]);

    expect(mocks.workReadyCommand).toHaveBeenCalledWith(
      {
        json: true,
        label: ["openclaw"],
        limit: 10,
        metadata: ["repo=openclaw/openclaw"],
      },
      mocks.runtime,
    );
  });

  it("forwards create options to the work command", async () => {
    await runCli([
      "work",
      "create",
      "Add Beads work tracking",
      "--type",
      "task",
      "--priority",
      "P1",
      "--label",
      "klaw",
      "--repo",
      "openclaw/openclaw",
      "--branch",
      "klaw/beads-work-tracking",
      "--pr-url",
      "https://github.com/openclaw/openclaw/pull/123",
      "--depends-on",
      "bd-parent",
    ]);

    expect(mocks.workCreateCommand).toHaveBeenCalledWith(
      {
        branch: "klaw/beads-work-tracking",
        dependsOn: ["bd-parent"],
        description: undefined,
        discoveredFrom: undefined,
        externalRef: undefined,
        json: false,
        label: ["klaw"],
        metadata: undefined,
        nextAction: undefined,
        owner: undefined,
        priority: "P1",
        prUrl: "https://github.com/openclaw/openclaw/pull/123",
        repo: "openclaw/openclaw",
        title: "Add Beads work tracking",
        type: "task",
      },
      mocks.runtime,
    );
  });

  it("rejects invalid ready limits", async () => {
    await runCli(["work", "ready", "--limit", "nope"]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "--limit must be a positive integer, for example --limit 25.",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.workReadyCommand).not.toHaveBeenCalled();
  });
});
