import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { applyWorkshopDraft, listWorkshopDrafts, saveWorkshopDraft } from "./drafts.js";
import {
  createWorkshopSkill,
  listWorkshopChanges,
  restoreWorkshopSkill,
  viewWorkshopSkill,
  writeWorkshopSkillFile,
} from "./library.js";
import { resolveWorkshopDraftsDir, resolveWorkshopSkillsDir } from "./skills-root.js";

const ctx = { config: {}, agentId: "main", actor: "user" as const };
const skillFile = (name: string, step: string) =>
  `---\nname: ${name}\ndescription: Deploy staging\n---\n\n1. ${step}\n`;

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  await createWorkshopSkill(ctx, {
    name: "deploy",
    content: skillFile("deploy", "Run make deploy."),
  });
});
afterEach(async () => {
  await state.cleanup();
});

it("applies a draft over the live skill as an undoable change and deletes the draft", async () => {
  const id = await saveWorkshopDraft({}, "main", {
    name: "deploy",
    content: skillFile("deploy", "Run make ship."),
    reason: "target was renamed",
  });

  const changes = await applyWorkshopDraft(ctx, id);

  expect(changes).toEqual([
    expect.objectContaining({ action: "write_file", actor: "user", summary: "target was renamed" }),
  ]);
  expect((await viewWorkshopSkill({}, "main", "deploy")).content).toContain("make ship");
  expect(await listWorkshopDrafts({}, "main")).toEqual([]);
  await restoreWorkshopSkill(ctx, { name: "deploy" });
  expect((await viewWorkshopSkill({}, "main", "deploy")).content).toContain("make deploy");
});

it("applies a multi-file draft as one change that a single undo reverts", async () => {
  // A Doctor export: a draft directory with a support file and no recorded reason.
  const draftDir = path.join(resolveWorkshopDraftsDir({}, "main"), "deploy-proposal-1");
  await fs.mkdir(path.join(draftDir, "references"), { recursive: true });
  await fs.writeFile(path.join(draftDir, "SKILL.md"), skillFile("deploy", "Run make ship."));
  await fs.writeFile(
    path.join(draftDir, "references", "rollback.md"),
    "Roll back with make undo.\n",
  );

  expect((await applyWorkshopDraft(ctx, "deploy-proposal-1")).map((c) => c.action)).toEqual([
    "write_file",
  ]);
  expect((await viewWorkshopSkill({}, "main", "deploy")).files).toEqual([
    "SKILL.md",
    "references/rollback.md",
  ]);

  await restoreWorkshopSkill(ctx, { name: "deploy" });
  const restored = await viewWorkshopSkill({}, "main", "deploy");
  expect(restored.content).toContain("make deploy");
  expect(restored.files).toEqual(["SKILL.md"]);
});

it("refuses to apply a draft under another skill's name", async () => {
  const id = await saveWorkshopDraft({}, "main", {
    name: "deploy",
    content: skillFile("deploy", "Run make ship."),
  });
  await expect(applyWorkshopDraft(ctx, id, "release-notes")).rejects.toThrow(
    /is for skill "deploy", not "release-notes"/,
  );
  expect((await listWorkshopDrafts({}, "main")).map((draft) => draft.id)).toEqual([id]);
});

it("publishes a binary support asset byte for byte", async () => {
  const draftDir = path.join(resolveWorkshopDraftsDir({}, "main"), "deploy-proposal-png");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
  await fs.mkdir(path.join(draftDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(draftDir, "SKILL.md"), skillFile("deploy", "Run make ship."));
  await fs.writeFile(path.join(draftDir, "assets", "logo.png"), png);

  await applyWorkshopDraft(ctx, "deploy-proposal-png");

  const live = path.join(resolveWorkshopSkillsDir({}, "main"), "deploy", "assets", "logo.png");
  expect((await fs.readFile(live)).equals(png)).toBe(true);
});

it("refuses a draft with a rejected support file before changing the skill", async () => {
  const draftDir = path.join(resolveWorkshopDraftsDir({}, "main"), "deploy-proposal-2");
  await fs.mkdir(path.join(draftDir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(draftDir, "SKILL.md"), skillFile("deploy", "Run make ship."));
  await fs.writeFile(
    path.join(draftDir, "scripts", "deploy.sh"),
    `export TOKEN=ghp_${"A".repeat(30)}\n`,
  );

  await expect(applyWorkshopDraft(ctx, "deploy-proposal-2")).rejects.toThrow(/literal-secret/);
  expect((await viewWorkshopSkill({}, "main", "deploy")).content).toContain("make deploy");
  expect(await listWorkshopChanges("main", {})).toHaveLength(1);
  expect((await listWorkshopDrafts({}, "main")).map((draft) => draft.id)).toEqual([
    "deploy-proposal-2",
  ]);
});

it("keeps the live skill whole when a later draft file cannot be written", async () => {
  await writeWorkshopSkillFile(ctx, {
    name: "deploy",
    filePath: "references/notes.md",
    content: "notes\n",
  });
  // SKILL.md is valid, but references/notes.md is a file in the live skill, so the nested
  // support file cannot be written after it.
  const draftDir = path.join(resolveWorkshopDraftsDir({}, "main"), "deploy-proposal-3");
  await fs.mkdir(path.join(draftDir, "references", "notes.md"), { recursive: true });
  await fs.writeFile(path.join(draftDir, "SKILL.md"), skillFile("deploy", "Run make ship."));
  await fs.writeFile(path.join(draftDir, "references", "notes.md", "x.md"), "x\n");

  await expect(applyWorkshopDraft(ctx, "deploy-proposal-3")).rejects.toThrow();
  const live = await viewWorkshopSkill({}, "main", "deploy");
  expect(live.content).toContain("make deploy");
  expect(live.files).toEqual(["SKILL.md", "references/notes.md"]);
  expect(await listWorkshopChanges("main", {})).toHaveLength(2);
});

it("creates a new skill from a draft and leaves the inbox when a draft changes nothing", async () => {
  const created = await saveWorkshopDraft({}, "main", {
    name: "release-notes",
    content: skillFile("release-notes", "Group by impact."),
  });
  expect((await applyWorkshopDraft(ctx, created)).map((c) => c.action)).toEqual(["create"]);
  expect((await viewWorkshopSkill({}, "main", "release-notes")).content).toContain("Group by");

  const same = await saveWorkshopDraft({}, "main", {
    name: "deploy",
    content: skillFile("deploy", "Run make deploy."),
  });
  expect(await applyWorkshopDraft(ctx, same)).toEqual([]);
  expect(await listWorkshopDrafts({}, "main")).toEqual([]);
});
