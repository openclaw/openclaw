import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const tempDirs = createTrackedTempDirs();

const mocks = vi.hoisted(() => ({
  workspaceDir: "",
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

vi.mock("../../skills/lifecycle/clawhub.js", () => ({
  installSkillFromClawHub: vi.fn(),
  readLocalSkillCardContentSync: vi.fn(),
  searchSkillsFromClawHub: vi.fn(),
  updateSkillsFromClawHub: vi.fn(),
}));

vi.mock("../../skills/lifecycle/install.js", () => ({
  installSkill: vi.fn(),
}));

vi.mock("../../skills/lifecycle/upload-install.js", () => ({
  installUploadedSkillArchive: vi.fn(),
}));

vi.mock("../../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: vi.fn(),
}));

vi.mock("../../skills/security/clawhub-verdicts.js", () => ({
  collectClawHubVerdictTargets: vi.fn(() => []),
  fetchOpenClawSkillSecurityVerdicts: vi.fn(),
}));

const { skillsHandlers } = await import("./skills.js");

function makeContext() {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: vi.fn(),
  };
}

async function callHandler(method: string, params: Record<string, unknown>) {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  await skillsHandlers[method]({
    params,
    req: {} as never,
    client: null as never,
    isWebchatConnect: () => false,
    context: makeContext() as never,
    respond: (success, result, err) => {
      ok = success;
      response = result;
      error = err;
    },
  });
  return { ok, response, error };
}

describe("skills proposal gateway handlers", () => {
  beforeEach(async () => {
    mocks.workspaceDir = await tempDirs.make("openclaw-skills-proposals-gateway-");
  });

  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it("creates, lists, inspects, and applies a proposal", async () => {
    const create = await callHandler("skills.proposals.create", {
      name: "Weather Planner",
      description: "Plan around current weather",
      content: "# Weather Planner\n\nCheck weather before outdoor recommendations.\n",
    });
    expect(create.ok).toBe(true);
    const created = create.response as { record: { id: string } };
    expect(created.record.id).toMatch(/^weather-planner-/);

    const list = await callHandler("skills.proposals.list", {});
    expect(list.ok).toBe(true);
    expect((list.response as { proposals: Array<{ id: string }> }).proposals[0]?.id).toBe(
      created.record.id,
    );

    const inspect = await callHandler("skills.proposals.inspect", {
      proposalId: created.record.id,
    });
    expect(inspect.ok).toBe(true);
    expect((inspect.response as { content: string }).content).toContain("status: proposal");

    const apply = await callHandler("skills.proposals.apply", {
      proposalId: created.record.id,
    });
    expect(apply.ok).toBe(true);
    await expect(
      fs.readFile(path.join(mocks.workspaceDir, "skills", "weather-planner", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Weather Planner");
  });

  it("rejects invalid params before touching workshop state", async () => {
    const result = await callHandler("skills.proposals.create", {
      name: "Missing Content",
      description: "No content",
    });
    expect(result.ok).toBe(false);
    expect((result.error as { code?: string }).code).toBe("INVALID_REQUEST");
    await expect(
      fs.access(path.join(mocks.workspaceDir, ".openclaw", "skill-workshop")),
    ).rejects.toThrow();
  });
});
