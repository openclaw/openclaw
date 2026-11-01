import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { WorkshopReviewNotFoundError } from "../../skills/workshop/review-undo.js";
import {
  resolveWorkshopDraftsDir,
  resolveWorkshopSkillsDir,
} from "../../skills/workshop/skills-root.js";
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
const undoWorkshopReview = vi.hoisted(() => vi.fn());

vi.mock("../../skills/workshop/library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/workshop/library.js")>()),
  ...library,
}));
vi.mock("../../skills/workshop/skill-usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/workshop/skill-usage.js")>()),
  readSkillUsage,
}));
vi.mock("../../skills/workshop/review-undo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/workshop/review-undo.js")>()),
  undoWorkshopReview,
}));

const config: OpenClawConfig = {
  agents: { entries: { ops: {} } },
  skills: { workshop: { autonomous: { mode: "off" } } },
};
const context = { getRuntimeConfig: () => config };
const call = (method: string, params: Record<string, unknown>) =>
  callGatewayHandler({ ...skillsWorkshopHandlers, ...skillsRetiredHandlers }, method, params, {
    context,
  });
const expectInvalid = (result: Awaited<ReturnType<typeof call>>, message?: string) =>
  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", ...(message === undefined ? {} : { message }) },
  });

const change = { id: "change-1" };

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
      drafts: [],
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

  it.each([
    ["skills.workshop.archive", { name: "deploy-notes" }],
    ["skills.workshop.restore", { name: "deploy-notes" }],
    ["skills.workshop.undo", { runId: "skill-workshop-review:1" }],
  ])("refuses %s once the requester loses authority after admission", async (method, params) => {
    const client = { invalidated: false };
    // The library calls assertLive right before its final file effect.
    const revokeThenCommit = async (ctx: { assertLive: () => void }) => {
      client.invalidated = true;
      ctx.assertLive();
      return change;
    };
    library.archiveWorkshopSkill.mockImplementation(revokeThenCommit);
    library.restoreWorkshopSkill.mockImplementation(revokeThenCommit);
    undoWorkshopReview.mockImplementation(revokeThenCommit);

    await expect(
      callGatewayHandler(skillsWorkshopHandlers, method, params, {
        client: client as never,
        context,
      }),
    ).rejects.toThrow("Gateway requester authority changed");
  });

  it.each(["skills.workshop.applyDraft", "skills.workshop.discardDraft"])(
    "refuses %s for a requester whose authority is gone and keeps the draft",
    async (method) => {
      const draftDir = path.join(resolveWorkshopDraftsDir(config, "ops"), "deploy-notes-1a2b3c4d");
      const draftFile = path.join(draftDir, "SKILL.md");
      await fs.mkdir(draftDir, { recursive: true });
      await fs.writeFile(draftFile, "---\nname: deploy-notes\ndescription: d\n---\n\n1. Step.\n");
      try {
        await expect(
          callGatewayHandler(
            skillsWorkshopHandlers,
            method,
            { name: "deploy-notes", draftId: "deploy-notes-1a2b3c4d" },
            { client: { invalidated: true } as never, context },
          ),
        ).rejects.toThrow("Gateway requester authority changed");
        expect(await fs.readFile(draftFile, "utf8")).toContain("1. Step.");
      } finally {
        await fs.rm(draftDir, { recursive: true, force: true });
      }
    },
  );

  it("returns library refusals and unknown agents as invalid requests", async () => {
    const missingSkill = 'Skill "ghost" does not exist.';
    const missingReview = "No skill changes recorded for review skill-workshop-review:9.";
    library.archiveWorkshopSkill.mockRejectedValue(new library.WorkshopWriteError(missingSkill));

    expectInvalid(await call("skills.workshop.archive", { name: "ghost" }), missingSkill);
    expectInvalid(await call("skills.workshop.restore", { agentId: "nope", name: "x" }));
    undoWorkshopReview.mockRejectedValue(new WorkshopReviewNotFoundError(missingReview));
    expectInvalid(
      await call("skills.workshop.undo", { runId: "skill-workshop-review:9" }),
      missingReview,
    );
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
