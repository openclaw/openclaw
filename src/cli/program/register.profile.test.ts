import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerProfileCommand } from "./register.profile.js";

const mocks = vi.hoisted(() => ({
  profileExportCommand: vi.fn(),
  profileImportCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/profile.js", () => ({
  profileExportCommand: mocks.profileExportCommand,
  profileImportCommand: mocks.profileImportCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerProfileCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerProfileCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profileExportCommand.mockResolvedValue(undefined);
    mocks.profileImportCommand.mockResolvedValue(undefined);
  });

  it("runs profile export with forwarded options", async () => {
    await runCli(["profile", "export", "--output", "/tmp/profiles", "--json", "--dry-run"]);

    expect(mocks.profileExportCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({
        output: "/tmp/profiles",
        json: true,
        dryRun: true,
        verify: false,
      }),
    );
  });

  it("forwards --verify to profile export", async () => {
    await runCli(["profile", "export", "--verify"]);

    expect(mocks.profileExportCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({
        verify: true,
      }),
    );
  });

  it("runs profile import with forwarded options", async () => {
    await runCli(["profile", "import", "/tmp/profile.openclaw-profile.tar.gz", "--json"]);

    expect(mocks.profileImportCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({
        archive: "/tmp/profile.openclaw-profile.tar.gz",
        json: true,
        dryRun: false,
      }),
    );
  });

  it("forwards --dry-run to profile import", async () => {
    await runCli(["profile", "import", "/tmp/profile.openclaw-profile.tar.gz", "--dry-run"]);

    expect(mocks.profileImportCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({
        dryRun: true,
      }),
    );
  });
});
