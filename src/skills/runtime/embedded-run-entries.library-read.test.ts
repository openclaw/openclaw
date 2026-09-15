import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { saveSkillLibrary } from "../library/service.js";
import * as workspaceLoader from "../loading/workspace-skill-loader.js";
import type { SkillSnapshot } from "../types.js";
import { resolveEmbeddedRunSkillEntries } from "./embedded-run-entries.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
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
  const native = requireNodeSqlite();
  const counters = [
    vi.spyOn(native.DatabaseSync.prototype, "prepare"),
    vi.spyOn(native.DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(native.StatementSync.prototype, method),
    ),
  ];
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
    expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    for (const counter of counters) {
      counter.mockRestore();
    }
  }
});

it("captures the library root at lazy invocation before workspace preparation yields", async () => {
  const { root, workspaceDir, snapshot } = await fixture();
  const otherRoot = dirs.make("embedded-library-other-");
  const gate = createDeferredCore();
  const entered = createDeferredCore();
  const prepareWorkspaceSkills = workspaceLoader.prepareWorkspaceSkills;
  vi.spyOn(workspaceLoader, "prepareWorkspaceSkills").mockImplementationOnce(async (...args) => {
    const entries = await prepareWorkspaceSkills(...args);
    entered.resolve();
    await gate.promise;
    return entries;
  });
  await withEnvAsync(
    { OPENCLAW_STATE_DIR: otherRoot, OPENCLAW_BUNDLED_SKILLS_DIR: workspaceDir },
    async () => {
      const result = await resolveEmbeddedRunSkillEntries({
        workspaceDir,
        config: { plugins: { enabled: false } },
        skillsSnapshot: snapshot,
      });
      process.env.OPENCLAW_STATE_DIR = root;
      const pending = result.loadSkillEntries();
      await entered.promise;
      process.env.OPENCLAW_STATE_DIR = otherRoot;
      gate.resolve();
      const entries = await pending;
      expect(entries).toHaveLength(2);
      expect(entries[0]?.skill.description).toBe("Saved procedure");
      expect(entries[0]?.skill.filePath.startsWith(`${root}${path.sep}`)).toBe(true);
      expect(fs.existsSync(path.join(otherRoot, "state", "openclaw.sqlite"))).toBe(false);
    },
  );
});
