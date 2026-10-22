import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareRuntimeSkillEntries as resolveEntries } from "../../agents/embedded-agent-runner/skills-prompt.js";
import { createDeferredCore as deferred } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  closeOpenClawStateDatabaseByPathAsync as closeDatabaseAt,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { saveSkillLibrary } from "../library/service.js";
import * as loader from "../loading/workspace-skill-loader.js";
import type { SkillEntry, SkillSnapshot } from "../types.js";

const dirs = useStateDatabaseTempDirs();
const content = "---\nname: guide\ndescription: Saved procedure\n---\n# Synthetic guide\n";
async function fixture() {
  const root = dirs.make("embedded-library-read-");
  const workspaceDir = dirs.make("embedded-library-workspace-");
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  const saved = await saveSkillLibrary(
    {
      profileId: ensureProfileForEmail("reader@example.test", options).id,
      scopes: ["operator.read", "operator.write"],
      getConfig: () => ({}),
      assertCurrent() {},
    },
    { slug: "guide", content, expectedRevision: null },
    options,
  );
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
  const skill = { name, description: "Saved procedure" };
  const expected = { skill, syncDirName: `library-${skillId}-${revision}` };
  await closeDatabase();
  const resolve = (skillsSnapshot = snapshot) =>
    resolveEntries({
      skillsAnchorWorkspace: workspaceDir,
      config: { plugins: { enabled: false } },
      skillsSnapshot,
    });
  const run = (test: () => Promise<void>) =>
    withEnvAsync({ OPENCLAW_STATE_DIR: root, OPENCLAW_BUNDLED_SKILLS_DIR: workspaceDir }, test);
  const check = (entries: SkillEntry[]) => expect(entries).toMatchObject([expected, expected]);
  return { root, pin, snapshot, resolve, run, check };
}

it("loads cold and cached library entries without parent SQL", async () => {
  const f = await fixture();
  const sql = observeMainThreadSql();
  try {
    await f.run(async () => {
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
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it.each(["root", "pins", "admission", "warm"] as const)("captures %s context", async (change) => {
  const f = await fixture();
  const otherRoot = dirs.make("embedded-library-other-");
  const gate = deferred();
  const entered = deferred();
  await f.run(async () => {
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
});
