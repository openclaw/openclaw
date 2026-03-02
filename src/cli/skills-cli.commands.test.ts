import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const buildWorkspaceSkillStatusMock = vi.fn();
const buildSkillSecurityVerdictExplainabilityMock = vi.fn();
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
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: buildWorkspaceSkillStatusMock,
}));

vi.mock("../security/skill-verdict.js", () => ({
  buildSkillSecurityVerdictExplainability: buildSkillSecurityVerdictExplainabilityMock,
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
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    buildWorkspaceSkillStatusMock.mockReturnValue(report);
    buildSkillSecurityVerdictExplainabilityMock.mockResolvedValue({
      verdict: "pass",
      confidence: 0.7,
      summary: { ruleIds: [] },
      findings: [],
      remediationHints: [],
      antiAbuse: { maxFiles: 500, maxFileBytes: 1024 * 1024, cappedAtMaxFiles: false },
    });
    formatSkillsListMock.mockReturnValue("skills-list-output");
    formatSkillInfoMock.mockReturnValue("skills-info-output");
    formatSkillsCheckMock.mockReturnValue("skills-check-output");
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
      undefined,
      undefined,
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-info-output");
  });

  it("supports inspect alias for info command", async () => {
    await runCli(["skills", "inspect", "peekaboo"]);

    expect(formatSkillInfoMock).toHaveBeenCalledWith(
      report,
      "peekaboo",
      expect.any(Object),
      undefined,
      undefined,
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-info-output");
  });

  it("loads and forwards security verdict data when inspecting an existing skill", async () => {
    const existingReport = {
      ...report,
      skills: [
        {
          name: "peekaboo",
          skillKey: "peekaboo",
          baseDir: "/tmp/workspace/skills/peekaboo",
        },
      ],
    };
    buildWorkspaceSkillStatusMock.mockReturnValue(existingReport);
    buildSkillSecurityVerdictExplainabilityMock.mockResolvedValue({
      skillKey: "peekaboo",
      skillName: "peekaboo",
      verdict: "review",
      confidence: 0.77,
      generatedAtMs: Date.now(),
      summary: { scannedFiles: 1, critical: 0, warn: 1, info: 0, ruleIds: ["suspicious-network"] },
      antiAbuse: { maxFiles: 500, maxFileBytes: 1024 * 1024, cappedAtMaxFiles: false },
      remediationHints: ["Restrict outbound endpoints."],
      findings: [],
    });

    await runCli(["skills", "inspect", "peekaboo"]);

    expect(buildSkillSecurityVerdictExplainabilityMock).toHaveBeenCalledWith({
      skillKey: "peekaboo",
      skillName: "peekaboo",
      skillDir: "/tmp/workspace/skills/peekaboo",
    });
    expect(formatSkillInfoMock).toHaveBeenCalledWith(
      existingReport,
      "peekaboo",
      expect.any(Object),
      expect.objectContaining({ verdict: "review" }),
      undefined,
    );
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
});
