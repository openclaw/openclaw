import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerInitCommand } from "./register.init.js";

const mocks = vi.hoisted(() => ({
  initCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/init.js", () => ({
  initCommand: mocks.initCommand,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

describe("registerInitCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initCommand.mockResolvedValue(undefined);
  });

  it("registers --mode teammate and --backend firecracker", async () => {
    const program = new Command();
    registerInitCommand(program);
    await program.parseAsync(
      ["init", "--mode", "teammate", "--backend", "firecracker", "--json"],
      { from: "user" },
    );
    expect(mocks.initCommand).toHaveBeenCalledWith(
      {
        mode: "teammate",
        backend: "firecracker",
        workspace: undefined,
        json: true,
      },
      mocks.runtime,
    );
  });
});
