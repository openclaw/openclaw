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
  DEFAULT_AGENT_ID: "main",
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

  it("supports targeting a specific agent workspace for list", async () => {
    resolveAgentWorkspaceDirMock.mockReturnValueOnce("/tmp/workspace-planner");

    await runCli(["skills", "list", "--agent", "planner"]);

    expect(normalizeAgentIdMock).toHaveBeenCalledWith("planner");
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({ gateway: {} }, "planner");
    expect(buildWorkspaceSkillStatusMock).toHaveBeenCalledWith("/tmp/workspace-planner", {
      config: { gateway: {} },
    });
  });

  it("accepts agent ids that normalize to a configured workspace", async () => {
    listAgentIdsMock.mockReturnValueOnce(["main", "_ops"]);
    normalizeAgentIdMock.mockImplementation((value: string) => {
      const trimmed = value.trim();
      return trimmed === "_ops" ? "_ops" : trimmed.toLowerCase();
    });
    resolveAgentWorkspaceDirMock.mockReturnValueOnce("/tmp/workspace-ops");

    await runCli(["skills", "list", "--agent", "_ops"]);

    expect(normalizeAgentIdMock).toHaveBeenCalledWith("_ops");
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({ gateway: {} }, "_ops");
    expect(buildWorkspaceSkillStatusMock).toHaveBeenCalledWith("/tmp/workspace-ops", {
      config: { gateway: {} },
    });
  });

  it("supports targeting a specific agent workspace for info", async () => {
    resolveAgentWorkspaceDirMock.mockReturnValueOnce("/tmp/workspace-planner");

    await runCli(["skills", "info", "peekaboo", "--agent", "planner"]);

    expect(normalizeAgentIdMock).toHaveBeenCalledWith("planner");
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({ gateway: {} }, "planner");
    expect(formatSkillInfoMock).toHaveBeenCalledWith(
      report,
      "peekaboo",
      expect.objectContaining({ agent: "planner" }),
    );
  });

  it("supports targeting a specific agent workspace for check", async () => {
    resolveAgentWorkspaceDirMock.mockReturnValueOnce("/tmp/workspace-planner");

    await runCli(["skills", "check", "--agent", "planner"]);

    expect(normalizeAgentIdMock).toHaveBeenCalledWith("planner");
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({ gateway: {} }, "planner");
    expect(formatSkillsCheckMock).toHaveBeenCalledWith(
      report,
      expect.objectContaining({ agent: "planner" }),
    );
  });

  it("rejects unknown agent ids", async () => {
    await runCli(["skills", "list", "--agent", "ghost"]);

    expect(runtime.error).toHaveBeenCalledWith(
      'Error: Unknown agent id "ghost". Use "openclaw agents list" to see configured agents.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
  });

  it("rejects malformed agent ids before normalization fallback", async () => {
    normalizeAgentIdMock.mockReturnValueOnce("main");

    await runCli(["skills", "list", "--agent", "!!!"]);

    expect(runtime.error).toHaveBeenCalledWith(
      'Error: Invalid agent id "!!!". Use "openclaw agents list" to see configured agents.',
    );
    expect(normalizeAgentIdMock).toHaveBeenCalledWith("!!!");
    expect(resolveAgentWorkspaceDirMock).not.toHaveBeenCalled();
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
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
