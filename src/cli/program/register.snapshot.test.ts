// Register snapshot tests cover core command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSnapshotCommand } from "./register.snapshot.js";

const mocks = vi.hoisted(() => ({
  snapshotCreateCommand: vi.fn(),
  snapshotListCommand: vi.fn(),
  snapshotRestoreCommand: vi.fn(),
  snapshotVerifyCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/snapshot.js", () => ({
  snapshotCreateCommand: mocks.snapshotCreateCommand,
  snapshotListCommand: mocks.snapshotListCommand,
  snapshotRestoreCommand: mocks.snapshotRestoreCommand,
  snapshotVerifyCommand: mocks.snapshotVerifyCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerSnapshotCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSnapshotCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshotCreateCommand.mockResolvedValue(0);
    mocks.snapshotListCommand.mockResolvedValue(0);
    mocks.snapshotRestoreCommand.mockResolvedValue(0);
    mocks.snapshotVerifyCommand.mockResolvedValue(0);
  });

  it("registers the snapshot command group", () => {
    const program = new Command();

    registerSnapshotCommand(program);

    const snapshot = program.commands.find((command) => command.name() === "snapshot");
    expect(snapshot?.commands.map((command) => command.name()).toSorted()).toEqual([
      "create",
      "list",
      "restore",
      "verify",
    ]);
  });

  it("runs snapshot create with forwarded options", async () => {
    await runCli([
      "snapshot",
      "create",
      "--db",
      "/tmp/source.sqlite",
      "--repository",
      "/tmp/snapshots",
      "--id",
      "global",
      "--kind",
      "control-plane",
      "--json",
    ]);

    expect(mocks.snapshotCreateCommand).toHaveBeenCalledWith(
      {
        db: "/tmp/source.sqlite",
        repository: "/tmp/snapshots",
        id: "global",
        kind: "control-plane",
        json: true,
      },
      mocks.runtime,
    );
  });

  it("runs snapshot create for a named global target", async () => {
    await runCli(["snapshot", "create", "--target", "global", "--repository", "/tmp/snapshots"]);

    expect(mocks.snapshotCreateCommand).toHaveBeenCalledWith(
      {
        target: "global",
        repository: "/tmp/snapshots",
      },
      mocks.runtime,
    );
  });

  it("runs snapshot create for a named agent target", async () => {
    await runCli(["snapshot", "create", "--agent", "main", "--repository", "/tmp/snapshots"]);

    expect(mocks.snapshotCreateCommand).toHaveBeenCalledWith(
      {
        agent: "main",
        repository: "/tmp/snapshots",
      },
      mocks.runtime,
    );
  });

  it("runs snapshot list with forwarded options", async () => {
    await runCli(["snapshot", "list", "--repository", "/tmp/snapshots", "--json"]);

    expect(mocks.snapshotListCommand).toHaveBeenCalledWith(
      { repository: "/tmp/snapshots", json: true },
      mocks.runtime,
    );
  });

  it("runs snapshot verify with forwarded options", async () => {
    await runCli(["snapshot", "verify", "/tmp/snapshots/one", "--json"]);

    expect(mocks.snapshotVerifyCommand).toHaveBeenCalledWith(
      "/tmp/snapshots/one",
      { json: true },
      mocks.runtime,
    );
  });

  it("runs snapshot restore with forwarded options", async () => {
    await runCli([
      "snapshot",
      "restore",
      "/tmp/snapshots/one",
      "--target",
      "/tmp/restore.sqlite",
      "--json",
    ]);

    expect(mocks.snapshotRestoreCommand).toHaveBeenCalledWith(
      "/tmp/snapshots/one",
      { target: "/tmp/restore.sqlite", json: true },
      mocks.runtime,
    );
  });
});
