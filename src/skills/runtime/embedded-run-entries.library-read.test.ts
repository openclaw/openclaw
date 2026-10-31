import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareRuntimeSkillEntries as resolveEntries } from "../../agents/embedded-agent-runner/skills-prompt.js";
import { createDeferredCore as deferred } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  closeOpenClawStateDatabaseByPathAsync as closeDatabaseAt,
} from "../../state/openclaw-state-db.js";
import { expectNoMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useSkillLibraryFixture } from "../library/service.test-support.js";
import * as loader from "../loading/workspace-skill-loader.js";
import type { SkillEntry, SkillSnapshot } from "../types.js";

const { fixture: libraryFixture, tempDirs: dirs } = useSkillLibraryFixture();
const content = "---\nname: guide\ndescription: Saved procedure\n---\n# Synthetic guide\n";
async function fixture() {
  const { stateDir: root, lib } = libraryFixture();
  const workspaceDir = dirs.make("embedded-library-workspace-");
  const saved = await lib.save({ slug: "guide", content, expectedRevision: null });
  const { skillId, revision, name, ownerProfileId } = saved.entry;
  const pin = { skillId, revision, name, ownerProfileId };
  // Workspace filtering must not remove already-authorized library pins.
  const snapshot: SkillSnapshot = {
    prompt: "cached prompt",
    skills: [],
    resolvedSkills: [],
    librarySelections: [pin, pin],
    skillFilter: [],
  };
  const expected = { skill: { name, description: "Saved procedure" } };
  await closeDatabase();
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", workspaceDir);
  const resolve = (skillsSnapshot = snapshot) =>
    resolveEntries({
      skillsAnchorWorkspace: workspaceDir,
      config: { plugins: { enabled: false } },
      skillsSnapshot,
    });
  const check = (entries: SkillEntry[]) => expect(entries).toMatchObject([expected, expected]);
  return { root, pin, snapshot, resolve, check };
}

it("loads cold and cached library entries without parent SQL", async () => {
  const f = await fixture();
  await expectNoMainThreadSql(async () => {
    for (let pass = 0; pass < 2; pass++) {
      const result = await f.resolve(structuredClone(f.snapshot));
      expect(result.skillEntries).toEqual([]);
      const entries = await result.loadSkillEntries();
      f.check(entries);
      for (const entry of entries) {
        expect(fs.readFileSync(entry.skill.filePath, "utf8")).toBe(content);
      }
      expect(await result.loadSkillEntries()).toBe(entries);
    }
    await closeDatabase();
  });
});

it.each(["root", "pins", "admission", "warm"] as const)("captures %s context", async (change) => {
  const f = await fixture();
  const otherRoot = dirs.make("embedded-library-other-");
  const gate = deferred();
  const entered = deferred();
  if (change === "warm") {
    await (await f.resolve()).loadSkillEntries();
  }
  const prepare = loader.prepareWorkspaceSkills;
  vi.spyOn(loader, "prepareWorkspaceSkills").mockImplementationOnce(async (...args) => {
    const entries = await prepare(...args);
    entered.resolve();
    await gate.promise;
    return entries;
  });
  process.env.OPENCLAW_STATE_DIR = otherRoot;
  const result = await f.resolve();
  process.env.OPENCLAW_STATE_DIR = f.root;
  const pending = result.loadSkillEntries();
  const outcome = pending.catch((error: unknown) => error);
  await entered.promise;
  if (change === "root") {
    process.env.OPENCLAW_STATE_DIR = otherRoot;
  } else if (change === "pins") {
    Object.assign(f.pin, {
      skillId: "changed",
      revision: "f".repeat(64),
      name: "changed",
      ownerProfileId: null,
    });
  } else {
    await closeDatabaseAt(path.join(f.root, "state", "openclaw.sqlite"));
  }
  gate.resolve();
  const invalidated = change === "admission" || change === "warm";
  if (invalidated) {
    expect(await outcome).toMatchObject({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" });
  }
  // Invalidated reads cannot fill the cache, but a fresh invocation may retry.
  const entries = invalidated ? await result.loadSkillEntries() : await pending;
  f.check(entries);
  expect(entries[0]?.skill.filePath.startsWith(`${f.root}${path.sep}`)).toBe(true);
  expect(await result.loadSkillEntries()).toBe(entries);
  expect(fs.existsSync(path.join(otherRoot, "state", "openclaw.sqlite"))).toBe(false);
});
