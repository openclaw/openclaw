import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
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

function skillStatusReport(skills: unknown[] = []) {
  return { skills };
}

async function callSkillsHandler(method: SkillsHandlerName, params: Record<string, unknown>) {
  return callGatewayHandler(skillsHandlers, method, params);
}

function linkedSkill(registry: string, ownerHandle?: string, slug = "weather") {
  return {
    clawhub: {
      status: "linked",
      valid: true,
      registry,
      slug,
      ownerHandle,
      installedVersion: "1.2.3",
    },
  };
}

describe("skills gateway handlers (clawhub)", () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue({});
    listAgentIdsMock.mockReset().mockReturnValue(["main"]);
    resolveDefaultAgentIdMock.mockReset().mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReset().mockReturnValue("/tmp/workspace");
    skillStatusReportMock.mockReset().mockReturnValue(skillStatusReport());
    skillStatusFilesMock.mockReset().mockReturnValue([]);
    fetchExactClawHubSkillSecurityVerdictsMock.mockReset();
    resolveClawHubBaseUrlMock.mockReset().mockReturnValue("https://clawhub.ai");
    installSkillFromClawHubMock.mockReset();
    installSkillMock.mockReset();
    updateSkillsFromClawHubMock.mockReset();
  });

  it("keeps owner-qualified verdict targets distinct for shared slugs", async () => {
    resolveClawHubBaseUrlMock.mockReturnValue("https://registry.example/base/");
    skillStatusReportMock.mockReturnValue(
      skillStatusReport([
        linkedSkill("https://registry.example/base", "alice"),
        linkedSkill("https://registry.example/base", "bob"),
      ]),
    );
    fetchExactClawHubSkillSecurityVerdictsMock.mockResolvedValue([
      {
        ok: true,
        decision: "pass",
        reasons: [],
        slug: "weather",
        version: "1.2.3",
        publisherHandle: "alice",
        security: { status: "clean", passed: true },
      },
      {
        ok: false,
        decision: "fail",
        reasons: ["security.suspicious"],
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
    skillStatusReportMock.mockReturnValue(
      skillStatusReport([linkedSkill("http://127.0.0.1:3999", undefined, "agentreceipt")]),
    );
    expect(await callSkillsHandler("skills.securityVerdicts", {})).toEqual({
      ok: true,
      error: undefined,
      response: { schema: "openclaw.skills.security-verdicts.v1", items: [] },
    });
    expect(fetchExactClawHubSkillSecurityVerdictsMock).not.toHaveBeenCalled();
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
    expect(response).toMatchObject({
      ok: true,
      message: "Installed calendar@1.2.3",
      slug: "calendar",
      version: "1.2.3",
      warning: "Review ClawHub security details before installing.",
    });
  });

  it("deduplicates concurrent exact ClawHub installs across reconnects", async () => {
    const install = createDeferredCore<unknown>();
    installSkillFromClawHubMock.mockReturnValue(install.promise);

    const params = {
      source: "clawhub",
      slug: "calendar",
      version: "1.2.3",
    } as const;
    const first = callSkillsHandler("skills.install", params);
    const reconnectRetry = callSkillsHandler("skills.install", params);

    await vi.waitFor(() => expect(installSkillFromClawHubMock).toHaveBeenCalledTimes(1));
    install.resolve({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace/skills/calendar",
    });

    expect(await Promise.all([first, reconnectRetry])).toMatchObject([{ ok: true }, { ok: true }]);
  });

  it("accepts deprecated unsafe override without forwarding it to skill installs", async () => {
    installSkillMock.mockResolvedValue({
      ok: true,
      message: "Installed",
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
    expect(response).toMatchObject({ ok: true, message: "Installed" });
  });

  it("forwards ClawHub skill update force overrides", async () => {
    updateSkillsFromClawHubMock.mockResolvedValue([{ ok: true }]);

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

  it.each(["install", "update"] as const)(
    "returns ClawHub %s trust warnings in Gateway error details",
    async (operation) => {
      const installing = operation === "install";
      const warning = installing
        ? "BLOCKED - ClawHub flagged this release as malicious"
        : "Latest skill version is marked malicious; OpenClaw will not download it.";
      const blocked = {
        ok: false,
        error: `ClawHub blocked this release; ${operation} was not started.`,
        code: "clawhub_download_blocked",
        ...(installing ? { version: "1.2.3" } : {}),
        warning,
      };
      (installing ? installSkillFromClawHubMock : updateSkillsFromClawHubMock).mockResolvedValue(
        installing ? blocked : [blocked],
      );
      expect(
        await callSkillsHandler(`skills.${operation}`, { source: "clawhub", slug: "calendar" }),
      ).toEqual({
        ok: false,
        response: installing
          ? blocked
          : {
              ok: false,
              skillKey: "calendar",
              config: { source: "clawhub", results: [blocked] },
            },
        error: {
          code: "UNAVAILABLE",
          message: blocked.error,
          details: installing
            ? { clawhubTrustCode: "clawhub_download_blocked", version: "1.2.3", warning }
            : { results: [blocked], warnings: [warning] },
        },
      });
    },
  );

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
