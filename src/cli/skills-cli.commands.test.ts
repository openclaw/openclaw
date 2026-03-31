import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeLogs: string[] = [];
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime = {
    log: vi.fn((...args: unknown[]) => {
      runtimeLogs.push(stringifyArgs(args));
    }),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    loadConfigMock: vi.fn(() => ({})),
    resolveDefaultAgentIdMock: vi.fn(() => "main"),
    resolveAgentWorkspaceDirMock: vi.fn(() => "/tmp/workspace"),
    searchSkillsFromClawHubMock: vi.fn(),
    installSkillFromClawHubMock: vi.fn(),
    updateSkillsFromClawHubMock: vi.fn(),
    readTrackedClawHubSkillSlugsMock: vi.fn(),
    defaultRuntime,
    runtimeLogs,
    runtimeErrors,
  };
});

const {
  loadConfigMock,
  resolveDefaultAgentIdMock,
  resolveAgentWorkspaceDirMock,
  searchSkillsFromClawHubMock,
  installSkillFromClawHubMock,
  updateSkillsFromClawHubMock,
  readTrackedClawHubSkillSlugsMock,
  defaultRuntime,
  runtimeLogs,
  runtimeErrors,
} = mocks;

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigMock(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => mocks.resolveDefaultAgentIdMock(),
  resolveAgentWorkspaceDir: () => mocks.resolveAgentWorkspaceDirMock(),
}));

vi.mock("../agents/skills-clawhub.js", () => ({
  searchSkillsFromClawHub: (...args: unknown[]) => mocks.searchSkillsFromClawHubMock(...args),
  installSkillFromClawHub: (...args: unknown[]) => mocks.installSkillFromClawHubMock(...args),
  updateSkillsFromClawHub: (...args: unknown[]) => mocks.updateSkillsFromClawHubMock(...args),
  readTrackedClawHubSkillSlugs: (...args: unknown[]) =>
    mocks.readTrackedClawHubSkillSlugsMock(...args),
}));

describe("skills cli commands", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    return program;
  };

  const runCommand = (argv: string[]) => createProgram().parseAsync(argv, { from: "user" });

  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    loadConfigMock.mockReset();
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    searchSkillsFromClawHubMock.mockReset();
    installSkillFromClawHubMock.mockReset();
    updateSkillsFromClawHubMock.mockReset();
    readTrackedClawHubSkillSlugsMock.mockReset();

    loadConfigMock.mockReturnValue({});
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    searchSkillsFromClawHubMock.mockResolvedValue([]);
    installSkillFromClawHubMock.mockResolvedValue({
      ok: false,
      error: "install disabled in test",
    });
    updateSkillsFromClawHubMock.mockResolvedValue([]);
    readTrackedClawHubSkillSlugsMock.mockResolvedValue([]);
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("searches ClawHub skills from the native CLI", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        slug: "calendar",
        displayName: "Calendar",
        summary: "CalDAV helpers",
        version: "1.2.3",
      },
    ]);

    await runCommand(["skills", "search", "calendar"]);

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      query: "calendar",
      limit: undefined,
    });
    expect(runtimeLogs.some((line) => line.includes("calendar v1.2.3  Calendar"))).toBe(true);
  });

  it("installs a skill from ClawHub into the active workspace", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace/skills/calendar",
    });

    await runCommand(["skills", "install", "calendar", "--version", "1.2.3"]);

    expect(installSkillFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      version: "1.2.3",
      force: false,
      logger: expect.any(Object),
    });
    expect(
      runtimeLogs.some((line) =>
        line.includes("Installed calendar@1.2.3 -> /tmp/workspace/skills/calendar"),
      ),
    ).toBe(true);
  });

  it("updates all tracked ClawHub skills", async () => {
    readTrackedClawHubSkillSlugsMock.mockResolvedValue(["calendar"]);
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: true,
        slug: "calendar",
        previousVersion: "1.2.2",
        version: "1.2.3",
        changed: true,
        targetDir: "/tmp/workspace/skills/calendar",
      },
    ]);

    await runCommand(["skills", "update", "--all"]);

    expect(readTrackedClawHubSkillSlugsMock).toHaveBeenCalledWith("/tmp/workspace");
    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: undefined,
      logger: expect.any(Object),
    });
    expect(runtimeLogs.some((line) => line.includes("Updated calendar: 1.2.2 -> 1.2.3"))).toBe(
      true,
    );
    expect(runtimeErrors).toEqual([]);
  });
});
