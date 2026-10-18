// ClawHub skills tests cover install/update/detail/status flows, security
// verdicts, local skill cards, and workspace skill status reports.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const loadConfigMock = vi.fn(() => ({}));
const listAgentIdsMock = vi.fn<(_cfg: unknown) => string[]>(() => ["main"]);
const resolveDefaultAgentIdMock = vi.fn(() => "main");
const resolveAgentWorkspaceDirMock = vi.fn<(_cfg: unknown, _agentId: string) => string>(
  () => "/tmp/workspace",
);
const skillStatusReportMock = vi.fn();
const skillStatusFilesMock = vi.fn();
const fetchExactClawHubSkillSecurityVerdictsMock = vi.fn();
const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.ai");
const installSkillFromClawHubMock = vi.fn();
const installSkillMock = vi.fn();
const updateSkillsFromClawHubMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: (cfg: unknown) => listAgentIdsMock(cfg),
  resolveAgentConfig: vi.fn(() => undefined),
  resolveDefaultAgentId: () => resolveDefaultAgentIdMock(),
  resolveAgentWorkspaceDir: (cfg: unknown, agentId: string) =>
    resolveAgentWorkspaceDirMock(cfg, agentId),
  resolveSessionAgentId: vi.fn(() => undefined),
}));

vi.mock("../../skills/lifecycle/clawhub.js", () => ({
  installSkillFromClawHub: (...args: unknown[]) => installSkillFromClawHubMock(...args),
  updateSkillsFromClawHub: (...args: unknown[]) => updateSkillsFromClawHubMock(...args),
}));

vi.mock("../../skills/discovery/status.js", () => ({
  prepareWorkspaceSkillStatus: async (...args: unknown[]) => ({
    report: skillStatusReportMock(...args),
    files: skillStatusFilesMock(),
  }),
}));

vi.mock("../../skills/lifecycle/install.js", () => ({
  installSkill: (...args: unknown[]) => installSkillMock(...args),
}));

vi.mock("../../infra/clawhub-skills.js", () => ({
  CLAWHUB_SKILLS_SH_REF_PREFIX: "skills-sh:",
  fetchClawHubSkillDetail: vi.fn(),
}));

vi.mock("../../infra/clawhub-client.js", () => ({
  resolveClawHubBaseUrl: () => resolveClawHubBaseUrlMock(),
}));

vi.mock("../../infra/clawhub-skill-security.js", () => ({
  fetchExactClawHubSkillSecurityVerdicts: (...args: unknown[]) =>
    fetchExactClawHubSkillSecurityVerdictsMock(...args),
}));

const { skillsHandlers } = await import("./skills.js");

type SkillsHandlerName = keyof typeof skillsHandlers;

function emptySkillStatusReport() {
  return {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/openclaw/skills",
    skills: [],
  };
}

async function callSkillsHandler(method: SkillsHandlerName, params: Record<string, unknown>) {
  return callGatewayHandler(skillsHandlers, method, params);
}

function expectEmptySecurityVerdicts(response: unknown): void {
  expect(response).toEqual({
    schema: "openclaw.skills.security-verdicts.v1",
    items: [],
  });
}

async function expectEmptySecurityVerdictsWithoutFetch(): Promise<void> {
  const { ok, response, error } = await callSkillsHandler("skills.securityVerdicts", {});

  expect(error).toBeUndefined();
  expect(ok).toBe(true);
  expect(fetchExactClawHubSkillSecurityVerdictsMock).not.toHaveBeenCalled();
  expectEmptySecurityVerdicts(response);
}

describe("skills gateway handlers (clawhub)", () => {
  afterEach(async () => {
    // skills.status opens real watchers; close them so they cannot outlive this file.
    await closeSkillsWatchers(true);
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    listAgentIdsMock.mockReset();
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    skillStatusReportMock.mockReset();
    skillStatusFilesMock.mockReset();
    skillStatusFilesMock.mockReturnValue([]);
    fetchExactClawHubSkillSecurityVerdictsMock.mockReset();
    resolveClawHubBaseUrlMock.mockReset();
    installSkillFromClawHubMock.mockReset();
    installSkillMock.mockReset();
    updateSkillsFromClawHubMock.mockReset();

    loadConfigMock.mockReturnValue({});
    listAgentIdsMock.mockReturnValue(["main"]);
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    skillStatusReportMock.mockReturnValue(emptySkillStatusReport());
    resolveClawHubBaseUrlMock.mockReturnValue("https://clawhub.ai");
  });

  it("builds status with the selected agent filter", async () => {
    listAgentIdsMock.mockReturnValue(["main", "research"]);
    resolveAgentWorkspaceDirMock.mockImplementation((_cfg, agentId) =>
      agentId === "research" ? "/tmp/research-workspace" : "/tmp/workspace",
    );

    const { ok, error } = await callSkillsHandler("skills.status", { agentId: "research" });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(skillStatusReportMock).toHaveBeenCalledWith(
      "/tmp/research-workspace",
      expect.objectContaining({
        agentId: "research",
        config: {},
        eligibility: expect.objectContaining({
          nodeSkills: expect.objectContaining({ canExec: expect.any(Boolean) }),
        }),
      }),
    );
  });

  it("keeps owner-qualified verdict targets distinct for shared slugs", async () => {
    resolveClawHubBaseUrlMock.mockReturnValue("https://registry.example/base/");
    skillStatusReportMock.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/openclaw/skills",
      skills: [
        {
          name: "alice-weather",
          skillKey: "alice-weather",
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://registry.example/base",
            slug: "weather",
            ownerHandle: "alice",
            installedVersion: "1.2.3",
            installedAt: 123,
          },
        },
        {
          name: "bob-weather",
          skillKey: "bob-weather",
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://registry.example/base",
            slug: "weather",
            ownerHandle: "bob",
            installedVersion: "1.2.3",
            installedAt: 456,
          },
        },
      ],
    });
    fetchExactClawHubSkillSecurityVerdictsMock.mockResolvedValue([
      {
        ok: true,
        decision: "pass",
        reasons: [],
        requestedSlug: "weather",
        requestedOwnerHandle: "alice",
        requestedVersion: "1.2.3",
        slug: "weather",
        version: "1.2.3",
        publisherHandle: "alice",
        security: { status: "clean", passed: true },
      },
      {
        ok: false,
        decision: "fail",
        reasons: ["security.suspicious"],
        requestedSlug: "weather",
        requestedOwnerHandle: "bob",
        requestedVersion: "1.2.3",
        slug: "weather",
        version: "1.2.3",
        publisherHandle: "bob",
        security: { status: "suspicious", passed: false },
      },
    ]);

    const { ok, response, error } = await callSkillsHandler("skills.securityVerdicts", {});

    expect(error).toBeUndefined();
    expect(fetchExactClawHubSkillSecurityVerdictsMock).toHaveBeenCalledTimes(1);
    expect(fetchExactClawHubSkillSecurityVerdictsMock).toHaveBeenCalledWith({
      baseUrl: "https://registry.example/base",
      items: [
        { slug: "weather", ownerHandle: "alice", version: "1.2.3" },
        { slug: "weather", ownerHandle: "bob", version: "1.2.3" },
      ],
      skipAuth: true,
    });
    expect(ok).toBe(true);
    expect(response).toEqual({
      schema: "openclaw.skills.security-verdicts.v1",
      items: [
        expect.objectContaining({
          requestedSlug: "weather",
          requestedOwnerHandle: "alice",
          requestedVersion: "1.2.3",
          publisherHandle: "alice",
        }),
        expect.objectContaining({
          requestedSlug: "weather",
          requestedOwnerHandle: "bob",
          requestedVersion: "1.2.3",
          publisherHandle: "bob",
        }),
      ],
    });
  });

  it("does not passively fetch verdicts from a non-configured registry", async () => {
    skillStatusReportMock.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/openclaw/skills",
      skills: [
        {
          name: "agentreceipt",
          skillKey: "agentreceipt",
          clawhub: {
            status: "linked",
            valid: true,
            registry: "http://127.0.0.1:3999",
            slug: "agentreceipt",
            installedVersion: "1.2.3",
            installedAt: 123,
          },
        },
      ],
    });

    await expectEmptySecurityVerdictsWithoutFetch();
  });

  it("loads local Skill Card content for a known installed skill", async () => {
    skillStatusReportMock.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/openclaw/skills",
      skills: [
        {
          name: "AgentReceipt",
          skillKey: "agentreceipt",
          baseDir: "/tmp/workspace/skills/agentreceipt",
          filePath: "/tmp/workspace/skills/agentreceipt/SKILL.md",
          skillCard: {
            present: true,
            path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
            sizeBytes: 34,
          },
        },
      ],
    });
    skillStatusFilesMock.mockReturnValue([
      {
        name: "AgentReceipt",
        filePath: "/tmp/workspace/skills/agentreceipt/SKILL.md",
        skillCard: { content: "# AgentReceipt\n\nLocal trust card.\n" },
      },
    ]);

    const { ok, response, error } = await callSkillsHandler("skills.skillCard", {
      skillKey: "agentreceipt",
    });

    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    expect(skillStatusReportMock).toHaveBeenCalledWith(
      "/tmp/workspace",
      expect.objectContaining({ skillCardKey: "agentreceipt" }),
    );
    expect(response).toEqual({
      schema: "openclaw.skills.skill-card.v1",
      skillKey: "agentreceipt",
      path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
      sizeBytes: 34,
      content: "# AgentReceipt\n\nLocal trust card.\n",
    });
  });

  it("installs a ClawHub skill through skills.install", async () => {
    listAgentIdsMock.mockReturnValue(["main", "research"]);
    resolveAgentWorkspaceDirMock.mockImplementation((_cfg, agentId) =>
      agentId === "research" ? "/tmp/research-workspace" : "/tmp/workspace",
    );
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/research-workspace/skills/calendar",
      warning: "Review ClawHub security details before installing.",
    });

    const { ok, response, error } = await callSkillsHandler("skills.install", {
      agentId: "research",
      source: "clawhub",
      slug: "@selected/calendar",
      version: "1.2.3",
    });

    expect(installSkillFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/research-workspace",
      slug: "@selected/calendar",
      version: "1.2.3",
      force: false,
      logger: expect.objectContaining({ warn: expect.any(Function) }),
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    const result = response as
      | { ok?: boolean; message?: string; slug?: string; version?: string; warning?: string }
      | undefined;
    expect(result?.ok).toBe(true);
    expect(result?.message).toBe("Installed calendar@1.2.3");
    expect(result?.slug).toBe("calendar");
    expect(result?.version).toBe("1.2.3");
    expect(result?.warning).toBe("Review ClawHub security details before installing.");
  });

  it("deduplicates concurrent exact ClawHub installs across reconnects", async () => {
    let finishInstall: ((value: unknown) => void) | undefined;
    installSkillFromClawHubMock.mockReturnValue(
      new Promise((resolve) => {
        finishInstall = resolve;
      }),
    );

    const params = {
      source: "clawhub",
      slug: "calendar",
      version: "1.2.3",
    } as const;
    const first = callSkillsHandler("skills.install", params);
    const reconnectRetry = callSkillsHandler("skills.install", params);

    await vi.waitFor(() => expect(installSkillFromClawHubMock).toHaveBeenCalledTimes(1));
    finishInstall?.({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace/skills/calendar",
    });

    const [firstResult, retryResult] = await Promise.all([first, reconnectRetry]);
    expect(firstResult.ok).toBe(true);
    expect(retryResult.ok).toBe(true);
  });

  it("returns ClawHub skill install trust warnings in Gateway error details", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: false,
      error: "ClawHub blocked this release; install was not started.",
      code: "clawhub_download_blocked",
      version: "1.2.3",
      warning: "BLOCKED - ClawHub flagged this release as malicious",
    });

    const { ok, response, error } = await callSkillsHandler("skills.install", {
      source: "clawhub",
      slug: "calendar",
    });

    expect(ok).toBe(false);
    expect(response).toEqual({
      ok: false,
      error: "ClawHub blocked this release; install was not started.",
      code: "clawhub_download_blocked",
      version: "1.2.3",
      warning: "BLOCKED - ClawHub flagged this release as malicious",
    });
    expect(error).toEqual({
      code: "UNAVAILABLE",
      message: "ClawHub blocked this release; install was not started.",
      details: {
        clawhubTrustCode: "clawhub_download_blocked",
        version: "1.2.3",
        warning: "BLOCKED - ClawHub flagged this release as malicious",
      },
    });
  });

  it("accepts deprecated unsafe override without forwarding it to skill installs", async () => {
    installSkillMock.mockResolvedValue({
      ok: true,
      message: "Installed",
      stdout: "",
      stderr: "",
      code: 0,
    });

    const { ok, response, error } = await callSkillsHandler("skills.install", {
      name: "calendar",
      installId: "deps",
      dangerouslyForceUnsafeInstall: true,
      timeoutMs: 120_000,
    });

    expect(installSkillMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      agentId: "main",
      skillName: "calendar",
      installId: "deps",
      timeoutMs: 120_000,
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    const result = response as { ok?: boolean; message?: string } | undefined;
    expect(result?.ok).toBe(true);
    expect(result?.message).toBe("Installed");
  });

  it("forwards ClawHub skill update force overrides", async () => {
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

    const { ok, error } = await callSkillsHandler("skills.update", {
      source: "clawhub",
      slug: "calendar",
      force: true,
    });

    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      force: true,
      logger: expect.objectContaining({ warn: expect.any(Function) }),
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
  });

  it("returns ClawHub skill update trust warnings in Gateway error details", async () => {
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: false,
        error: "ClawHub blocked this release; update was not started.",
        code: "clawhub_download_blocked",
        warning: "Latest skill version is marked malicious; OpenClaw will not download it.",
      },
    ]);

    const { ok, response, error } = await callSkillsHandler("skills.update", {
      source: "clawhub",
      slug: "calendar",
    });

    expect(ok).toBe(false);
    expect(response).toEqual({
      ok: false,
      skillKey: "calendar",
      config: {
        source: "clawhub",
        results: [
          {
            ok: false,
            error: "ClawHub blocked this release; update was not started.",
            code: "clawhub_download_blocked",
            warning: "Latest skill version is marked malicious; OpenClaw will not download it.",
          },
        ],
      },
    });
    expect(error).toEqual({
      code: "UNAVAILABLE",
      message: "ClawHub blocked this release; update was not started.",
      details: {
        results: [
          {
            ok: false,
            error: "ClawHub blocked this release; update was not started.",
            code: "clawhub_download_blocked",
            warning: "Latest skill version is marked malicious; OpenClaw will not download it.",
          },
        ],
        warnings: ["Latest skill version is marked malicious; OpenClaw will not download it."],
      },
    });
  });

  it("rejects ClawHub skills.update requests without slug or all", async () => {
    const { ok, error } = await callSkillsHandler("skills.update", {
      source: "clawhub",
    });
    const typedError = error as { code?: string; message?: string } | undefined;

    expect(ok).toBe(false);
    expect(typedError?.message).toContain('requires "slug" or "all"');
    expect(updateSkillsFromClawHubMock).not.toHaveBeenCalled();
  });
});
