import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const listAgentIdsMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const normalizeAgentIdMock = vi.fn();
const buildWorkspaceSkillStatusMock = vi.fn();
const formatSkillsListMock = vi.fn();
const formatSkillInfoMock = vi.fn();
const formatSkillsCheckMock = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: listAgentIdsMock,
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../routing/session-key.js", () => ({
  normalizeAgentId: normalizeAgentIdMock,
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: buildWorkspaceSkillStatusMock,
}));

vi.mock("./skills-cli.format.js", () => ({
  formatSkillsList: formatSkillsListMock,
  formatSkillInfo: formatSkillInfoMock,
  formatSkillsCheck: formatSkillsCheckMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerSkillsCli: typeof import("./skills-cli.js").registerSkillsCli;

beforeAll(async () => {
  ({ registerSkillsCli } = await import("./skills-cli.js"));
});

describe("registerSkillsCli", () => {
  const report = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/workspace/.skills",
    skills: [],
  };

  async function runCli(args: string[]) {
    const program = new Command();
    registerSkillsCli(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({ gateway: {} });
    listAgentIdsMock.mockReturnValue(["main", "planner"]);
    normalizeAgentIdMock.mockImplementation((value: string) => value.trim().toLowerCase());
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    buildWorkspaceSkillStatusMock.mockReturnValue(report);
    formatSkillsListMock.mockReturnValue("skills-list-output");
    formatSkillInfoMock.mockReturnValue("skills-info-output");
    formatSkillsCheckMock.mockReturnValue("skills-check-output");
  });

  it("runs list command with resolved report and formatter options", async () => {
    await runCli(["skills", "list", "--eligible", "--verbose", "--json"]);

    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({ gateway: {} }, "main");
    expect(buildWorkspaceSkillStatusMock).toHaveBeenCalledWith("/tmp/workspace", {
      config: { gateway: {} },
    });
    expect(formatSkillsListMock).toHaveBeenCalledWith(
      report,
      expect.objectContaining({
        eligible: true,
        verbose: true,
        json: true,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-list-output");
  });

  it("runs info command and forwards skill name", async () => {
    await runCli(["skills", "info", "peekaboo", "--json"]);

    expect(formatSkillInfoMock).toHaveBeenCalledWith(
      report,
      "peekaboo",
      expect.objectContaining({ json: true }),
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-info-output");
  });

  it("runs check command and writes formatter output", async () => {
    await runCli(["skills", "check"]);

    expect(formatSkillsCheckMock).toHaveBeenCalledWith(report, expect.any(Object));
    expect(runtime.log).toHaveBeenCalledWith("skills-check-output");
  });

  it("uses list formatter for default skills action", async () => {
    await runCli(["skills"]);

    expect(formatSkillsListMock).toHaveBeenCalledWith(report, {});
    expect(runtime.log).toHaveBeenCalledWith("skills-list-output");
  });

  it("supports targeting a specific agent workspace", async () => {
    resolveAgentWorkspaceDirMock.mockReturnValueOnce("/tmp/workspace-planner");

    await runCli(["skills", "list", "--agent", "planner"]);

    expect(normalizeAgentIdMock).toHaveBeenCalledWith("planner");
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({ gateway: {} }, "planner");
    expect(buildWorkspaceSkillStatusMock).toHaveBeenCalledWith("/tmp/workspace-planner", {
      config: { gateway: {} },
    });
  });

  it("rejects unknown agent ids", async () => {
    await runCli(["skills", "list", "--agent", "ghost"]);

    expect(runtime.error).toHaveBeenCalledWith(
      'Error: Unknown agent id "ghost". Use "openclaw agents list" to see configured agents.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
  });

  it("reports runtime errors when report loading fails", async () => {
    loadConfigMock.mockImplementationOnce(() => {
      throw new Error("config exploded");
    });

    await runCli(["skills", "list"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: config exploded");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
  });
});
