import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn(() => ({}));
const resolveDefaultAgentIdMock = vi.fn(() => "main");
const resolveAgentWorkspaceDirMock = vi.fn(() => "/tmp/workspace");
const installSkillFromClawHubMock = vi.fn();
const installSkillMock = vi.fn();
const uninstallSkillFromClawHubMock = vi.fn();
const updateSkillsFromClawHubMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: () => resolveDefaultAgentIdMock(),
  resolveAgentWorkspaceDir: () => resolveAgentWorkspaceDirMock(),
}));

vi.mock("../../agents/skills-clawhub.js", () => ({
  installSkillFromClawHub: (...args: unknown[]) => installSkillFromClawHubMock(...args),
  uninstallSkillFromClawHub: (...args: unknown[]) => uninstallSkillFromClawHubMock(...args),
  updateSkillsFromClawHub: (...args: unknown[]) => updateSkillsFromClawHubMock(...args),
}));

vi.mock("../../agents/skills-install.js", () => ({
  installSkill: (...args: unknown[]) => installSkillMock(...args),
}));

const { skillsHandlers } = await import("./skills.js");

describe("skills gateway handlers (clawhub)", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    installSkillFromClawHubMock.mockReset();
    installSkillMock.mockReset();
    uninstallSkillFromClawHubMock.mockReset();
    updateSkillsFromClawHubMock.mockReset();

    loadConfigMock.mockReturnValue({});
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
  });

  it("installs a ClawHub skill through skills.install", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace/skills/calendar",
    });

    let ok: boolean | null = null;
    let response: unknown;
    let error: unknown;
    await skillsHandlers["skills.install"]({
      params: {
        source: "clawhub",
        slug: "calendar",
        version: "1.2.3",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, result, err) => {
        ok = success;
        response = result;
        error = err;
      },
    });

    expect(installSkillFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      version: "1.2.3",
      force: false,
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toMatchObject({
      ok: true,
      message: "Installed calendar@1.2.3",
      slug: "calendar",
      version: "1.2.3",
    });
  });

  it("forwards dangerous override for local skill installs", async () => {
    installSkillMock.mockResolvedValue({
      ok: true,
      message: "Installed",
      stdout: "",
      stderr: "",
      code: 0,
    });

    let ok: boolean | null = null;
    let response: unknown;
    let error: unknown;
    await skillsHandlers["skills.install"]({
      params: {
        name: "calendar",
        installId: "deps",
        dangerouslyForceUnsafeInstall: true,
        timeoutMs: 120_000,
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, result, err) => {
        ok = success;
        response = result;
        error = err;
      },
    });

    expect(installSkillMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      skillName: "calendar",
      installId: "deps",
      dangerouslyForceUnsafeInstall: true,
      timeoutMs: 120_000,
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toMatchObject({
      ok: true,
      message: "Installed",
    });
  });

  it("updates ClawHub skills through skills.update", async () => {
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

    let ok: boolean | null = null;
    let response: unknown;
    let error: unknown;
    await skillsHandlers["skills.update"]({
      params: {
        source: "clawhub",
        slug: "calendar",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, result, err) => {
        ok = success;
        response = result;
        error = err;
      },
    });

    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toMatchObject({
      ok: true,
      skillKey: "calendar",
      config: {
        source: "clawhub",
        results: [
          {
            ok: true,
            slug: "calendar",
            version: "1.2.3",
          },
        ],
      },
    });
  });

  it("rejects ClawHub skills.update requests without slug or all", async () => {
    let ok: boolean | null = null;
    let error: { code?: string; message?: string } | undefined;
    await skillsHandlers["skills.update"]({
      params: {
        source: "clawhub",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err as { code?: string; message?: string } | undefined;
      },
    });

    expect(ok).toBe(false);
    expect(error?.message).toContain('requires "slug" or "all"');
    expect(updateSkillsFromClawHubMock).not.toHaveBeenCalled();
  });

  it("uninstalls an installed ClawHub skill through skills.uninstall", async () => {
    uninstallSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      removed: true,
      targetDir: "/tmp/workspace/skills/calendar",
      previousVersion: "1.2.3",
    });

    let ok: boolean | null = null;
    let response: unknown;
    let error: unknown;
    await skillsHandlers["skills.uninstall"]({
      params: { slug: "calendar" },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, result, err) => {
        ok = success;
        response = result;
        error = err;
      },
    });

    expect(uninstallSkillFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toMatchObject({
      ok: true,
      slug: "calendar",
      removed: true,
      previousVersion: "1.2.3",
      message: "Uninstalled calendar",
    });
  });

  it("returns removed=false idempotently when slug is not installed", async () => {
    uninstallSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "nope",
      removed: false,
      targetDir: "/tmp/workspace/skills/nope",
      previousVersion: null,
    });

    let ok: boolean | null = null;
    let response: { removed?: boolean; message?: string } | undefined;
    let error: unknown;
    await skillsHandlers["skills.uninstall"]({
      params: { slug: "nope", source: "clawhub" },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, result, err) => {
        ok = success;
        response = result as { removed?: boolean; message?: string } | undefined;
        error = err;
      },
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response?.removed).toBe(false);
    expect(response?.message).toBe("Skill nope was not installed");
  });

  it("rejects skills.uninstall with an empty slug", async () => {
    let ok: boolean | null = null;
    let error: { code?: string; message?: string } | undefined;
    await skillsHandlers["skills.uninstall"]({
      params: { slug: "" },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err as { code?: string; message?: string } | undefined;
      },
    });

    expect(ok).toBe(false);
    expect(error?.code).toBe("INVALID_REQUEST");
    expect(uninstallSkillFromClawHubMock).not.toHaveBeenCalled();
  });

  it("surfaces backend errors from skills.uninstall as UNAVAILABLE", async () => {
    uninstallSkillFromClawHubMock.mockResolvedValue({
      ok: false,
      error: "boom",
    });

    let ok: boolean | null = null;
    let error: { code?: string; message?: string } | undefined;
    await skillsHandlers["skills.uninstall"]({
      params: { slug: "calendar" },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: {} as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err as { code?: string; message?: string } | undefined;
      },
    });

    expect(ok).toBe(false);
    expect(error?.code).toBe("UNAVAILABLE");
    expect(error?.message).toBe("boom");
  });
});
