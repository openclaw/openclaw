import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { skillsRetiredHandlers } from "./skills-retired.js";
import { skillsWorkshopHandlers } from "./skills-workshop.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const library = vi.hoisted(() => ({
  WorkshopWriteError: class WorkshopWriteError extends Error {},
  listWorkshopSkills: vi.fn(),
  listWorkshopArchive: vi.fn(),
  listWorkshopChanges: vi.fn(),
  viewWorkshopSkill: vi.fn(),
  archiveWorkshopSkill: vi.fn(),
  restoreWorkshopSkill: vi.fn(),
}));
const readSkillUsage = vi.hoisted(() => vi.fn());

vi.mock("../../skills/workshop/library.js", () => library);
vi.mock("../../skills/workshop/skill-usage.js", () => ({ readSkillUsage }));

const config: OpenClawConfig = {
  agents: { list: [{ id: "ops", default: true }] },
  skills: { workshop: { autonomous: { mode: "off" } } },
};
const context = { getRuntimeConfig: () => config };
const call = (method: string, params: Record<string, unknown>) =>
  callGatewayHandler({ ...skillsWorkshopHandlers, ...skillsRetiredHandlers }, method, params, {
    context,
  });

const change = {
  id: "change-1",
  agentId: "ops",
  skillName: "deploy-notes",
  action: "archive",
  actor: "user",
  summary: "archived",
  versionId: "20260929T000000000Z-archive",
  createdAtMs: 1,
};

describe("skills.workshop gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists skills with usage keyed by the canonical SKILL.md path", async () => {
    const root = resolveWorkshopSkillsDir(config, "ops");
    const usedFile = canonicalizePath(path.join(root, "deploy-notes", "SKILL.md"));
    const summary = { description: "d", updatedAtMs: 1, sizeBytes: 10, files: ["SKILL.md"] };
    library.listWorkshopSkills.mockResolvedValue([
      { name: "deploy-notes", ...summary },
      { name: "unused", ...summary },
    ]);
    const archived = [{ name: "old", live: false, versions: [] }];
    library.listWorkshopArchive.mockResolvedValue(archived);
    readSkillUsage.mockResolvedValue(new Map([[usedFile, { useCount: 3, lastUsedAtMs: 9 }]]));

    const result = await call("skills.workshop.list", {});

    expect(result.ok).toBe(true);
    expect(result.response).toEqual({
      agentId: "ops",
      mode: "off",
      root,
      skills: [
        { name: "deploy-notes", ...summary, useCount: 3, lastUsedAtMs: 9 },
        { name: "unused", ...summary },
      ],
      archived,
    });
  });

  it("pages changes and reads skill files for the resolved agent", async () => {
    library.listWorkshopChanges.mockResolvedValue([change]);
    const view = { name: "deploy-notes", filePath: "SKILL.md", content: "x", files: ["SKILL.md"] };
    library.viewWorkshopSkill.mockResolvedValue(view);

    const changes = await call("skills.workshop.changes", { limit: 5, beforeMs: 100 });
    const read = await call("skills.workshop.read", {
      name: "deploy-notes",
      versionId: "20260929T000000000Z-patch",
    });

    expect(changes.response).toEqual({ changes: [change] });
    expect(library.listWorkshopChanges).toHaveBeenCalledWith("ops", { limit: 5, beforeMs: 100 });
    expect(read.response).toEqual(view);
    expect(library.viewWorkshopSkill).toHaveBeenCalledWith(
      config,
      "ops",
      "deploy-notes",
      undefined,
      "20260929T000000000Z-patch",
    );
  });

  it("archives and restores as the user actor", async () => {
    library.archiveWorkshopSkill.mockResolvedValue(change);
    library.restoreWorkshopSkill.mockResolvedValue({ ...change, action: "restore" });

    const archived = await call("skills.workshop.archive", { name: "deploy-notes", reason: "dup" });
    const restored = await call("skills.workshop.restore", { name: "deploy-notes" });

    const ctx = { config, agentId: "ops", actor: "user" };
    expect(archived.response).toEqual({ change });
    expect(library.archiveWorkshopSkill).toHaveBeenCalledWith(ctx, {
      name: "deploy-notes",
      reason: "dup",
    });
    expect(restored.response).toEqual({ change: { ...change, action: "restore" } });
    expect(library.restoreWorkshopSkill).toHaveBeenCalledWith(ctx, {
      name: "deploy-notes",
      versionId: undefined,
    });
  });

  it("returns library refusals and unknown agents as invalid requests", async () => {
    library.archiveWorkshopSkill.mockRejectedValue(
      new library.WorkshopWriteError('Skill "ghost" does not exist.'),
    );

    const refused = await call("skills.workshop.archive", { name: "ghost" });
    const unknownAgent = await call("skills.workshop.restore", { agentId: "nope", name: "x" });

    expect(refused).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: 'Skill "ghost" does not exist.' },
    });
    expect(unknownAgent).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(library.restoreWorkshopSkill).not.toHaveBeenCalled();
  });

  it("answers retired proposal and curator methods with Workshop guidance", async () => {
    for (const method of ["skills.proposals.apply", "skills.curator.status"]) {
      const result = await call(method, { proposalId: "p1", anything: true });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: expect.stringContaining("skills.workshop.") },
      });
    }
  });
});
