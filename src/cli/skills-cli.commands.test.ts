import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const buildWorkspaceSkillStatusMock = vi.fn();
const installSkillMock = vi.fn();
const formatSkillsListMock = vi.fn();
const formatSkillInfoMock = vi.fn();
const formatSkillsCheckMock = vi.fn();
const createCliProgressMock = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: buildWorkspaceSkillStatusMock,
}));

vi.mock("../agents/skills-install.js", () => ({
  installSkill: installSkillMock,
}));

vi.mock("./skills-cli.format.js", () => ({
  formatSkillsList: formatSkillsListMock,
  formatSkillInfo: formatSkillInfoMock,
  formatSkillsCheck: formatSkillsCheckMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

vi.mock("./progress.js", () => ({
  createCliProgress: createCliProgressMock,
}));

vi.mock("./command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

vi.mock("../terminal/theme.js", () => ({
  theme: {
    muted: (s: string) => s,
    success: (s: string) => s,
  },
}));

vi.mock("../terminal/links.js", () => ({
  formatDocsLink: (path: string, label: string) => `${label} (${path})`,
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

  const progressMock = {
    setLabel: vi.fn(),
    setPercent: vi.fn(),
    tick: vi.fn(),
    done: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({ gateway: {} });
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    buildWorkspaceSkillStatusMock.mockReturnValue(report);
    formatSkillsListMock.mockReturnValue("skills-list-output");
    formatSkillInfoMock.mockReturnValue("skills-info-output");
    formatSkillsCheckMock.mockReturnValue("skills-check-output");
    createCliProgressMock.mockReturnValue(progressMock);
  });

  it("runs list command with resolved report and formatter options", async () => {
    await runCli(["skills", "list", "--eligible", "--verbose", "--json"]);

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

  it("reports runtime errors when report loading fails", async () => {
    loadConfigMock.mockImplementationOnce(() => {
      throw new Error("config exploded");
    });

    await runCli(["skills", "list"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: config exploded");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
  });

  describe("install subcommand", () => {
    const reportWithSkill = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/workspace/.skills",
      skills: [
        {
          name: "peekaboo",
          install: [
            {
              id: "brew-peekaboo",
              kind: "brew",
              label: "brew install peekaboo",
            },
          ],
        },
        {
          name: "no-install",
          install: [],
        },
      ],
    };

    it("installs skill successfully and prints success", async () => {
      buildWorkspaceSkillStatusMock.mockReturnValue(reportWithSkill);
      installSkillMock.mockResolvedValue({
        ok: true,
        message: "",
        stdout: "",
        stderr: "",
      });

      await runCli(["skills", "install", "peekaboo"]);

      expect(installSkillMock).toHaveBeenCalledWith({
        workspaceDir: "/tmp/workspace",
        skillName: "peekaboo",
        installId: "brew-peekaboo",
        timeoutMs: 300_000,
        config: { gateway: {} },
      });
      expect(progressMock.done).toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Installed peekaboo"));
      expect(runtime.exit).not.toHaveBeenCalled();
    });

    it("prints warnings on successful install with warnings", async () => {
      buildWorkspaceSkillStatusMock.mockReturnValue(reportWithSkill);
      installSkillMock.mockResolvedValue({
        ok: true,
        message: "",
        stdout: "",
        stderr: "",
        warnings: ["old version detected"],
      });

      await runCli(["skills", "install", "peekaboo"]);

      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Installed peekaboo (with warnings)"),
      );
      expect(runtime.log).toHaveBeenCalledWith("old version detected");
    });

    it("prints error and exits 1 on install failure", async () => {
      buildWorkspaceSkillStatusMock.mockReturnValue(reportWithSkill);
      installSkillMock.mockResolvedValue({
        ok: false,
        message: "brew not found",
        stdout: "",
        stderr: "command not found: brew",
        code: 127,
      });

      await runCli(["skills", "install", "peekaboo"]);

      expect(runtime.error).toHaveBeenCalledWith("Install failed: peekaboo (exit 127)");
      expect(runtime.log).toHaveBeenCalledWith("command not found: brew");
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });

    it("prints error and exits 1 when skill not found", async () => {
      buildWorkspaceSkillStatusMock.mockReturnValue(reportWithSkill);

      await runCli(["skills", "install", "nonexistent"]);

      expect(runtime.error).toHaveBeenCalledWith("Skill not found: nonexistent");
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(installSkillMock).not.toHaveBeenCalled();
    });

    it("prints error when no install options available", async () => {
      buildWorkspaceSkillStatusMock.mockReturnValue(reportWithSkill);

      await runCli(["skills", "install", "no-install"]);

      expect(runtime.error).toHaveBeenCalledWith(
        "No install options available for skill: no-install",
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(installSkillMock).not.toHaveBeenCalled();
    });

    it("forwards --install-id option", async () => {
      buildWorkspaceSkillStatusMock.mockReturnValue(reportWithSkill);
      installSkillMock.mockResolvedValue({
        ok: true,
        message: "",
        stdout: "",
        stderr: "",
      });

      await runCli(["skills", "install", "peekaboo", "--install-id", "custom-id"]);

      expect(installSkillMock).toHaveBeenCalledWith(
        expect.objectContaining({ installId: "custom-id" }),
      );
    });

    it("forwards --timeout option", async () => {
      buildWorkspaceSkillStatusMock.mockReturnValue(reportWithSkill);
      installSkillMock.mockResolvedValue({
        ok: true,
        message: "",
        stdout: "",
        stderr: "",
      });

      await runCli(["skills", "install", "peekaboo", "--timeout", "60000"]);

      expect(installSkillMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
    });
  });
});
