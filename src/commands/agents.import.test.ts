import { beforeEach, describe, expect, it, vi } from "vitest";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfigFileMock(params.nextConfig)),
);

const fileExistsMock = vi.hoisted(() => vi.fn());
const extractArchiveMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../infra/archive.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/archive.js")>("../infra/archive.js")),
  fileExists: fileExistsMock,
  extractArchive: extractArchiveMock,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: vi.fn().mockReturnValue({
    confirm: vi.fn().mockResolvedValue(true),
  }),
}));

import { agentsImportCommand } from "./agents.js";

const runtime = createTestRuntime();

describe("agents import command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    replaceConfigFileMock.mockClear();
    fileExistsMock.mockClear();
    extractArchiveMock.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("requires file path", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsImportCommand({ file: "" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("required"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("errors when file does not exist", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    fileExistsMock.mockResolvedValue(false);

    await agentsImportCommand({ file: "/nonexistent/agent.tar.gz" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("errors on unsupported archive format", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    fileExistsMock.mockResolvedValue(true);

    await agentsImportCommand({ file: "/path/to/agent.txt" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported archive format"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("errors when agent.json is missing from archive", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    // Return true for input file, false for agent.json path
    fileExistsMock.mockImplementation((p: string) => Promise.resolve(!p.endsWith("agent.json")));

    await agentsImportCommand({ file: "/path/to/agent.tar.gz" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Archive missing required file"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });
});
