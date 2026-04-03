import { beforeEach, describe, expect, it, vi } from "vitest";

const searchSkillsFromClawHubMock = vi.fn();
const fetchSkillDetailFromClawHubMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
}));

vi.mock("../../agents/skills-clawhub.js", () => ({
  installSkillFromClawHub: vi.fn(),
  updateSkillsFromClawHub: vi.fn(),
  searchSkillsFromClawHub: (...args: unknown[]) => searchSkillsFromClawHubMock(...args),
  fetchSkillDetailFromClawHub: (...args: unknown[]) => fetchSkillDetailFromClawHubMock(...args),
}));

vi.mock("../../agents/skills-install.js", () => ({
  installSkill: vi.fn(),
}));

const { skillsHandlers } = await import("./skills.js");

function callHandler(method: string, params: unknown) {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  const promise = skillsHandlers[method]({
    params,
    req: {} as never,
    client: null as never,
    isWebchatConnect: () => false,
    context: {} as never,
    respond: (success: boolean, result: unknown, err: unknown) => {
      ok = success;
      response = result;
      error = err;
    },
  });
  return promise.then(() => ({ ok, response, error }));
}

describe("skills.search handler", () => {
  beforeEach(() => {
    searchSkillsFromClawHubMock.mockReset();
    fetchSkillDetailFromClawHubMock.mockReset();
  });

  it("searches ClawHub with query and limit", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        score: 0.95,
        slug: "github",
        displayName: "GitHub",
        summary: "GitHub integration",
        version: "1.0.0",
        updatedAt: 1700000000,
      },
    ]);

    const { ok, response, error } = await callHandler("skills.search", {
      query: "github",
      limit: 10,
    });

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      query: "github",
      limit: 10,
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toEqual({
      results: [
        {
          score: 0.95,
          slug: "github",
          displayName: "GitHub",
          summary: "GitHub integration",
          version: "1.0.0",
          updatedAt: 1700000000,
        },
      ],
    });
  });

  it("searches without query (browse all)", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([]);

    const { ok, response } = await callHandler("skills.search", {});

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      query: undefined,
      limit: undefined,
    });
    expect(ok).toBe(true);
    expect(response).toEqual({ results: [] });
  });

  it("returns error when ClawHub is unreachable", async () => {
    searchSkillsFromClawHubMock.mockRejectedValue(new Error("connection refused"));

    const { ok, error } = await callHandler("skills.search", { query: "test" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ message: "connection refused" });
  });

  it("rejects invalid params", async () => {
    const { ok, error } = await callHandler("skills.search", {
      query: "test",
      limit: 0,
    });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(searchSkillsFromClawHubMock).not.toHaveBeenCalled();
  });
});

describe("skills.detail handler", () => {
  beforeEach(() => {
    searchSkillsFromClawHubMock.mockReset();
    fetchSkillDetailFromClawHubMock.mockReset();
  });

  it("fetches detail for a valid slug", async () => {
    const detail = {
      skill: {
        slug: "github",
        displayName: "GitHub",
        summary: "GitHub integration",
        createdAt: 1700000000,
        updatedAt: 1700000000,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 1700000000,
      },
      owner: {
        handle: "openclaw",
        displayName: "OpenClaw",
      },
    };
    fetchSkillDetailFromClawHubMock.mockResolvedValue(detail);

    const { ok, response, error } = await callHandler("skills.detail", {
      slug: "github",
    });

    expect(fetchSkillDetailFromClawHubMock).toHaveBeenCalledWith({ slug: "github" });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toEqual(detail);
  });

  it("returns error when slug is not found", async () => {
    fetchSkillDetailFromClawHubMock.mockRejectedValue(new Error("not found"));

    const { ok, error } = await callHandler("skills.detail", { slug: "nonexistent" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ message: "not found" });
  });

  it("rejects missing slug", async () => {
    const { ok, error } = await callHandler("skills.detail", {});

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchSkillDetailFromClawHubMock).not.toHaveBeenCalled();
  });

  it("rejects empty slug", async () => {
    const { ok, error } = await callHandler("skills.detail", { slug: "" });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchSkillDetailFromClawHubMock).not.toHaveBeenCalled();
  });
});
