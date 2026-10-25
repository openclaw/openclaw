import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  files: vi.fn(),
  fetchExactClawHubSkillSecurityVerdicts: vi.fn(),
  resolveClawHubBaseUrl: vi.fn(() => "https://clawhub.ai"),
  installSkillFromClawHub: vi.fn(),
  installSkill: vi.fn(),
  updateSkillsFromClawHub: vi.fn(),
}));

vi.mock("../../skills/lifecycle/clawhub.js", () => ({
  installSkillFromClawHub: mocks.installSkillFromClawHub,
  updateSkillsFromClawHub: mocks.updateSkillsFromClawHub,
}));

vi.mock("../../skills/discovery/status.js", () => ({
  prepareWorkspaceSkillStatus: async (...args: unknown[]) => ({
    report: mocks.report(...args),
    files: mocks.files(),
  }),
}));

vi.mock("../../skills/lifecycle/install.js", () => ({
  installSkill: mocks.installSkill,
}));

vi.mock("../../infra/clawhub-skills.js", () => ({
  CLAWHUB_SKILLS_SH_REF_PREFIX: "skills-sh:",
  fetchClawHubSkillDetail: vi.fn(),
}));

vi.mock("../../infra/clawhub-client.js", () => ({
  resolveClawHubBaseUrl: mocks.resolveClawHubBaseUrl,
}));

vi.mock("../../infra/clawhub-skill-security.js", () => ({
  fetchExactClawHubSkillSecurityVerdicts: mocks.fetchExactClawHubSkillSecurityVerdicts,
}));

const { skillsHandlers } = await import("./skills.js");

const config: OpenClawConfig = { agents: { entries: { main: { workspace: "/tmp/workspace" } } } };
const callSkillsHandler = (method: string, params: Record<string, unknown>, cfg = config) =>
  callGatewayHandler(skillsHandlers, method, params, { context: { getRuntimeConfig: () => cfg } });

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
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.resolveClawHubBaseUrl.mockReturnValue("https://clawhub.ai");
    mocks.report.mockReturnValue({ skills: [] });
    mocks.files.mockReturnValue([]);
  });

  it("keeps owner-qualified verdict targets distinct for shared slugs", async () => {
    mocks.resolveClawHubBaseUrl.mockReturnValue("https://registry.example/base/");
    mocks.report.mockReturnValue({
      skills: [
        linkedSkill("https://registry.example/base", "alice"),
        linkedSkill("https://registry.example/base", "bob"),
      ],
    });
    mocks.fetchExactClawHubSkillSecurityVerdicts.mockResolvedValue(
      ["alice", "bob"].map((publisherHandle) => ({
        ok: publisherHandle === "alice",
        decision: publisherHandle === "alice" ? "pass" : "fail",
        reasons: publisherHandle === "alice" ? [] : ["security.suspicious"],
        slug: "weather",
        version: "1.2.3",
        publisherHandle,
        security: {
          status: publisherHandle === "alice" ? "clean" : "suspicious",
          passed: publisherHandle === "alice",
        },
      })),
    );

    const result = await callSkillsHandler("skills.securityVerdicts", {});
    expect(mocks.fetchExactClawHubSkillSecurityVerdicts).toHaveBeenCalledWith({
      baseUrl: "https://registry.example/base",
      items: [
        { slug: "weather", ownerHandle: "alice", version: "1.2.3" },
        { slug: "weather", ownerHandle: "bob", version: "1.2.3" },
      ],
      skipAuth: true,
    });
    expect(result).toEqual({
      ok: true,
      error: undefined,
      response: {
        schema: "openclaw.skills.security-verdicts.v1",
        items: ["alice", "bob"].map((owner) =>
          expect.objectContaining({
            requestedSlug: "weather",
            requestedOwnerHandle: owner,
            requestedVersion: "1.2.3",
            publisherHandle: owner,
          }),
        ),
      },
    });
  });

  it("does not passively fetch verdicts from a non-configured registry", async () => {
    mocks.report.mockReturnValue({
      skills: [linkedSkill("http://127.0.0.1:3999", undefined, "agentreceipt")],
    });
    expect(await callSkillsHandler("skills.securityVerdicts", {})).toEqual({
      ok: true,
      error: undefined,
      response: { schema: "openclaw.skills.security-verdicts.v1", items: [] },
    });
    expect(mocks.fetchExactClawHubSkillSecurityVerdicts).not.toHaveBeenCalled();
  });

  it("installs a ClawHub skill through skills.install", async () => {
    const researchConfig: OpenClawConfig = {
      agents: {
        entries: { ...config.agents?.entries, research: { workspace: "/tmp/research-workspace" } },
      },
    };
    const installed = {
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/research-workspace/skills/calendar",
      warning: "Review ClawHub security details before installing.",
    };
    mocks.installSkillFromClawHub.mockResolvedValue(installed);

    const result = await callSkillsHandler(
      "skills.install",
      { agentId: "research", source: "clawhub", slug: "@selected/calendar", version: "1.2.3" },
      researchConfig,
    );

    expect(mocks.installSkillFromClawHub).toHaveBeenCalledWith({
      workspaceDir: "/tmp/research-workspace",
      slug: "@selected/calendar",
      version: "1.2.3",
      force: false,
      logger: expect.objectContaining({ warn: expect.any(Function) }),
      config: researchConfig,
    });
    expect(result).toMatchObject({
      ok: true,
      error: undefined,
      response: { ...installed, message: "Installed calendar@1.2.3" },
    });
  });

  it("deduplicates concurrent exact ClawHub installs across reconnects", async () => {
    const install = createDeferredCore<unknown>();
    mocks.installSkillFromClawHub.mockReturnValue(install.promise);

    const params = {
      source: "clawhub",
      slug: "calendar",
      version: "1.2.3",
    } as const;
    const first = callSkillsHandler("skills.install", params);
    const reconnectRetry = callSkillsHandler("skills.install", params);

    await vi.waitFor(() => expect(mocks.installSkillFromClawHub).toHaveBeenCalledTimes(1));
    install.resolve({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace/skills/calendar",
    });

    expect(await Promise.all([first, reconnectRetry])).toMatchObject([{ ok: true }, { ok: true }]);
  });

  it("accepts deprecated unsafe override without forwarding it to skill installs", async () => {
    mocks.installSkill.mockResolvedValue({ ok: true, message: "Installed" });

    const result = await callSkillsHandler("skills.install", {
      name: "calendar",
      installId: "deps",
      dangerouslyForceUnsafeInstall: true,
      timeoutMs: 120_000,
    });

    expect(mocks.installSkill).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      agentId: "main",
      skillName: "calendar",
      installId: "deps",
      timeoutMs: 120_000,
      config,
    });
    expect(result).toMatchObject({
      ok: true,
      error: undefined,
      response: { ok: true, message: "Installed" },
    });
  });

  it("forwards ClawHub skill update force overrides", async () => {
    mocks.updateSkillsFromClawHub.mockResolvedValue([{ ok: true }]);

    const result = await callSkillsHandler("skills.update", {
      source: "clawhub",
      slug: "calendar",
      force: true,
    });

    expect(mocks.updateSkillsFromClawHub).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      force: true,
      logger: expect.objectContaining({ warn: expect.any(Function) }),
      config,
    });
    expect(result).toMatchObject({ ok: true, error: undefined });
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
      (installing
        ? mocks.installSkillFromClawHub
        : mocks.updateSkillsFromClawHub
      ).mockResolvedValue(installing ? blocked : [blocked]);
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
    expect(await callSkillsHandler("skills.update", { source: "clawhub" })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('requires "slug" or "all"') },
    });
    expect(mocks.updateSkillsFromClawHub).not.toHaveBeenCalled();
  });
});
