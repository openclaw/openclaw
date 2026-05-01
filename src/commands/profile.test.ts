import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  createProfileArchive: vi.fn(),
  importProfileArchive: vi.fn(),
  writeRuntimeJson: vi.fn(),
}));

vi.mock("../infra/profile-portability.js", () => ({
  createProfileArchive: mocks.createProfileArchive,
  importProfileArchive: mocks.importProfileArchive,
  formatProfileExportSummary: () => ["export summary"],
  formatProfileImportSummary: () => ["import summary"],
}));

vi.mock("../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime.js")>("../runtime.js");
  return {
    ...actual,
    writeRuntimeJson: mocks.writeRuntimeJson,
  };
});

const { profileExportCommand, profileImportCommand } = await import("./profile.js");

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("profile commands", () => {
  it("writes JSON for profile export", async () => {
    const result = {
      archivePath: "/tmp/profile.openclaw-profile.tar.gz",
      dryRun: true,
    };
    mocks.createProfileArchive.mockResolvedValueOnce(result);
    const runtime = createRuntime();

    await profileExportCommand(runtime, { json: true, dryRun: true });

    expect(mocks.writeRuntimeJson).toHaveBeenCalledWith(runtime, result);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("writes JSON for profile import", async () => {
    const result = {
      archivePath: "/tmp/profile.openclaw-profile.tar.gz",
      dryRun: true,
    };
    mocks.importProfileArchive.mockResolvedValueOnce(result);
    const runtime = createRuntime();

    await profileImportCommand(runtime, {
      archive: "/tmp/profile.openclaw-profile.tar.gz",
      json: true,
      dryRun: true,
    });

    expect(mocks.writeRuntimeJson).toHaveBeenCalledWith(runtime, result);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
