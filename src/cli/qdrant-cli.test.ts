import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  },
  runQdrantWorkspaceReconcileCommand: vi.fn(async () => ({
    ok: true,
    mode: "dry-run",
  })),
  runCommandWithRuntime: vi.fn(
    async (
      runtime: { error: (message: string) => void; exit: (code: number) => void },
      action: () => Promise<void>,
    ) => {
      try {
        await action();
      } catch (err) {
        runtime.error(String(err));
        runtime.exit(1);
      }
    },
  ),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../commands/qdrant-workspace-reconcile.js", () => ({
  runQdrantWorkspaceReconcileCommand: mocks.runQdrantWorkspaceReconcileCommand,
}));

vi.mock("./cli-utils.js", () => ({
  runCommandWithRuntime: mocks.runCommandWithRuntime,
}));

describe("qdrant cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers reconcile and forwards dry-run json options", async () => {
    const { registerQdrantCli } = await import("./qdrant-cli.js");
    const program = new Command();
    program.exitOverride();
    registerQdrantCli(program);

    await program.parseAsync(["qdrant", "workspace", "reconcile", "--dry-run", "--json"], {
      from: "user",
    });

    expect(mocks.runQdrantWorkspaceReconcileCommand).toHaveBeenCalledWith(
      {
        apply: false,
        dryRun: true,
        json: true,
      },
      mocks.defaultRuntime,
    );
  });

  it("defaults to dry-run when no mode flag is provided", async () => {
    const { registerQdrantCli } = await import("./qdrant-cli.js");
    const program = new Command();
    program.exitOverride();
    registerQdrantCli(program);

    await program.parseAsync(["qdrant", "workspace", "reconcile"], {
      from: "user",
    });

    expect(mocks.runQdrantWorkspaceReconcileCommand).toHaveBeenCalledWith(
      {
        apply: false,
        dryRun: false,
        json: false,
      },
      mocks.defaultRuntime,
    );
  });

  it("reports an error for conflicting apply and dry-run flags", async () => {
    mocks.runQdrantWorkspaceReconcileCommand.mockRejectedValueOnce(
      new Error("Choose either --dry-run or --apply"),
    );
    const { registerQdrantCli } = await import("./qdrant-cli.js");
    const program = new Command();
    program.exitOverride();
    registerQdrantCli(program);

    await expect(
      program.parseAsync(["qdrant", "workspace", "reconcile", "--apply", "--dry-run"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.runQdrantWorkspaceReconcileCommand).toHaveBeenCalledWith(
      {
        apply: true,
        dryRun: true,
        json: false,
      },
      mocks.defaultRuntime,
    );
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Choose either --dry-run or --apply"),
    );
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("reports command errors through runCommandWithRuntime", async () => {
    mocks.runQdrantWorkspaceReconcileCommand.mockRejectedValueOnce(new Error("qdrant down"));
    const { registerQdrantCli } = await import("./qdrant-cli.js");
    const program = new Command();
    program.exitOverride();
    registerQdrantCli(program);

    await expect(
      program.parseAsync(["qdrant", "workspace", "reconcile", "--apply"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("qdrant down"));
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("registers qdrant through core subcli wiring", async () => {
    const [{ registerSubCliByName }, { getSubCliEntries, getSubCliCommandsWithSubcommands }] =
      await Promise.all([
        import("./program/register.subclis-core.js"),
        import("./program/subcli-descriptors.js"),
      ]);
    const program = new Command();

    expect(getSubCliEntries().some((descriptor) => descriptor.name === "qdrant")).toBe(true);
    expect(getSubCliCommandsWithSubcommands()).toContain("qdrant");
    await expect(registerSubCliByName(program, "qdrant")).resolves.toBe(true);
    expect(program.commands.some((command) => command.name() === "qdrant")).toBe(true);
  });
});
