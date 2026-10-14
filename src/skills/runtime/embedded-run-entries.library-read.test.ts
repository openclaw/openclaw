import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { saveSkillLibrary } from "../library/service.js";
import * as workspaceLoader from "../loading/workspace-skill-loader.js";
import type { SkillSnapshot } from "../types.js";
import { resolveEmbeddedRunSkillEntries } from "./embedded-run-entries.js";

const dirs = useStateDatabaseTempDirs();
const content = "---\nname: guide\ndescription: Saved procedure\n---\n# Synthetic guide\n";

async function fixture() {
  const root = dirs.make("embedded-library-read-");
  const workspaceDir = dirs.make("embedded-library-workspace-");
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  const profile = ensureProfileForEmail("reader@example.test", options);
  const saved = await saveSkillLibrary(
    {
      profileId: profile.id,
      scopes: ["operator.read", "operator.write"],
      getConfig: () => ({}),
      assertCurrent() {},
    },
    { slug: "guide", content, expectedRevision: null },
    options,
  );
  const pin = {
    skillId: saved.entry.skillId,
    revision: saved.entry.revision,
    name: saved.entry.name,
    ownerProfileId: saved.entry.ownerProfileId,
  };
  const snapshot: SkillSnapshot = {
    prompt: "cached prompt",
    skills: [],
    resolvedSkills: [],
    librarySelections: [pin, pin],
    // Workspace filtering must not remove already-authorized library pins.
    skillFilter: [],
  };
  await closeOpenClawStateDatabaseAsync();
  return { root, workspaceDir, snapshot, pin };
}

it("loads cold and cached library entries through the real getter without parent SQL", async () => {
  const { root, workspaceDir, snapshot, pin } = await fixture();
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  try {
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: root, OPENCLAW_BUNDLED_SKILLS_DIR: workspaceDir },
      async () => {
        for (let pass = 0; pass < 2; pass++) {
          const result = await resolveEmbeddedRunSkillEntries({
            workspaceDir,
            config: { plugins: { enabled: false } },
            skillsSnapshot: structuredClone(snapshot),
          });
          expect(result.skillEntries).toEqual([]);
          const entries = await result.loadSkillEntries();
          expect(entries.map(({ skill }) => skill.name)).toEqual([pin.name, pin.name]);
          for (const entry of entries) {
            expect(entry.skill.description).toBe("Saved procedure");
            expect(fs.readFileSync(entry.skill.filePath, "utf8")).toBe(content);
            expect(entry.syncDirName).toBe(`library-${pin.skillId}-${pin.revision}`);
          }
          expect(await result.loadSkillEntries()).toBe(entries);
        }
        await closeOpenClawStateDatabaseAsync();
      },
    );
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it.each([
  { change: "root", warm: false },
  { change: "pins", warm: false },
  { change: "admission", warm: false },
  { change: "admission", warm: true },
] as const)(
  "retains the lazy invocation's library context across a $change change (warm=$warm)",
  async ({ change, warm }) => {
    const { root, workspaceDir, snapshot, pin } = await fixture();
    const originalPin = { ...pin };
    const otherRoot = dirs.make("embedded-library-other-");
    const gate = createDeferredCore();
    const entered = createDeferredCore();
    const resolve = () =>
      resolveEmbeddedRunSkillEntries({
        workspaceDir,
        config: { plugins: { enabled: false } },
        skillsSnapshot: snapshot,
      });
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: root, OPENCLAW_BUNDLED_SKILLS_DIR: workspaceDir },
      async () => {
        if (warm) {
          await (await resolve()).loadSkillEntries();
        }
        const prepareWorkspaceSkills = workspaceLoader.prepareWorkspaceSkills;
        vi.spyOn(workspaceLoader, "prepareWorkspaceSkills").mockImplementationOnce(
          async (...args) => {
            const entries = await prepareWorkspaceSkills(...args);
            entered.resolve();
            await gate.promise;
            return entries;
          },
        );
        process.env.OPENCLAW_STATE_DIR = otherRoot;
        const result = await resolve();
        process.env.OPENCLAW_STATE_DIR = root;
        const pending = result.loadSkillEntries();
        const outcome = pending.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await entered.promise;
        if (change === "root") {
          process.env.OPENCLAW_STATE_DIR = otherRoot;
        } else if (change === "pins") {
          Object.assign(pin, {
            skillId: "changed",
            revision: "f".repeat(64),
            name: "changed",
            ownerProfileId: null,
          });
        } else {
          await closeOpenClawStateDatabaseByPathAsync(path.join(root, "state", "openclaw.sqlite"));
        }
        gate.resolve();
        if (change === "admission") {
          expect(await outcome).toMatchObject({
            error: { code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" },
          });
        }
        // A fresh invocation may retry, but the invalidated one must never fill its cache.
        const entries = change === "admission" ? await result.loadSkillEntries() : await pending;
        expect(entries).toHaveLength(2);
        expect(entries.map((entry) => entry.skill.name)).toEqual([
          originalPin.name,
          originalPin.name,
        ]);
        expect(entries[0]?.syncDirName).toBe(
          `library-${originalPin.skillId}-${originalPin.revision}`,
        );
        expect(entries[0]?.skill.description).toBe("Saved procedure");
        expect(entries[0]?.skill.filePath.startsWith(`${root}${path.sep}`)).toBe(true);
        expect(await result.loadSkillEntries()).toBe(entries);
        expect(fs.existsSync(path.join(otherRoot, "state", "openclaw.sqlite"))).toBe(false);
      },
    );
  },
);
