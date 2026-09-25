import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { prepareSkillCommandsForWorkspace } from "../discovery/chat-commands.js";
import * as librarySelection from "../library/selection.js";
import { saveSkillLibrary } from "../library/service.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  prepareWorkspaceSkills,
  resolveWorkspaceSkillPromptEntries,
} from "./workspace-skill-loader.js";

// Plugin command discovery owns separate storage; this regression measures Library reads.
vi.mock("../../plugins/bundle-commands.js", () => ({
  loadEnabledClaudeBundleCommands: () => [],
}));

const dirs = useStateDatabaseTempDirs();
const content = "---\nname: guide\ndescription: Saved procedure\n---\n# Synthetic guide\n";

async function fixture() {
  const root = dirs.make("workspace-library-read-");
  const workspaceDir = dirs.make("workspace-library-workspace-");
  const config: OpenClawConfig = { plugins: { enabled: false } };
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  const profile = ensureProfileForEmail("reader@example.test", options);
  const authority = {
    profileId: profile.id,
    scopes: ["operator.read", "operator.write"],
    getConfig: () => config,
    assertCurrent() {},
  };
  const saved = await saveSkillLibrary(
    authority,
    { slug: "guide", content, expectedRevision: null },
    options,
  );
  const pin = {
    skillId: saved.entry.skillId,
    revision: saved.entry.revision,
    name: saved.entry.name,
    ownerProfileId: saved.entry.ownerProfileId,
  };
  const updated = await saveSkillLibrary(
    authority,
    {
      skillId: pin.skillId,
      slug: "guide",
      content: content.replace("Saved procedure", "Replacement procedure"),
      expectedRevision: pin.revision,
    },
    options,
  );
  await closeOpenClawStateDatabaseAsync();
  const loadOptions = {
    config,
    managedSkillsDir: path.join(root, "skills"),
    bundledSkillsDir: path.join(root, "bundled"),
    librarySelections: [pin],
    eligibility: {},
  };
  return {
    root,
    workspaceDir,
    config,
    pin,
    updated,
    loadOptions,
    run<T>(use: () => Promise<T>) {
      return withEnvAsync(
        {
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_BUNDLED_SKILLS_DIR: loadOptions.bundledSkillsDir,
        },
        use,
      );
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Surface = "workspace" | "prompt";

async function prepare(surface: Surface, test: Fixture, assertCurrent?: () => void) {
  return surface === "workspace"
    ? prepareWorkspaceSkills(test.workspaceDir, test.loadOptions, assertCurrent)
    : (
        await resolveWorkspaceSkillPromptEntries(test.workspaceDir, {
          ...test.loadOptions,
          assertCurrent,
        })
      ).eligible;
}

it("prepares cold and warm pinned commands without parent SQL and preserves filtering", async () => {
  const test = await fixture();
  await writeSkill({
    dir: path.join(test.workspaceDir, "skills", "local"),
    name: "local",
    description: "Local procedure",
  });
  requireNodeSqlite();
  const sql = observeMainThreadSql({ includeClose: true });
  try {
    await test.run(async () => {
      const commandParams = {
        workspaceDir: test.workspaceDir,
        cfg: test.config,
        sessionEntry: {
          permissionMode: "full" as const,
          skillLibrarySelections: [test.pin],
        },
      };
      for (let pass = 0; pass < 2; pass++) {
        const commands = await prepareSkillCommandsForWorkspace(commandParams);
        expect(commands.map((command) => command.skillName)).toEqual(["local", test.pin.name]);
        const selected = commands[1]!;
        expect(selected.description).toBe("Saved procedure");
        expect(selected.skillFile).toContain(`${path.sep}${test.pin.revision}${path.sep}`);
        expect(fs.readFileSync(selected.skillFile!, "utf8")).toBe(content);
      }
      const filtered = await prepareSkillCommandsForWorkspace({
        ...commandParams,
        skillFilter: [test.pin.name],
      });
      expect(filtered.map((command) => command.skillName)).toEqual([test.pin.name]);
      expect(await prepareSkillCommandsForWorkspace({ ...commandParams, skillFilter: [] })).toEqual(
        [],
      );
      await closeOpenClawStateDatabaseAsync();
    });
    sql.expectIdle();
  } finally {
    sql.restore();
  }
});

it.each(["workspace", "prompt"] as const)(
  "%s refresh retries retain captured Library root and pin values",
  async (surface) => {
    const test = await fixture();
    const originalPin = { ...test.pin };
    const otherRoot = dirs.make("workspace-library-other-");
    const entered = createDeferredCore();
    const gate = createDeferredCore();
    const original = librarySelection.prepareSkillLibrarySelection;
    vi.spyOn(librarySelection, "prepareSkillLibrarySelection").mockImplementationOnce(
      async (...args) => {
        entered.resolve();
        await gate.promise;
        return original(...args);
      },
    );
    await test.run(async () => {
      const pending = prepare(surface, test);
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(
          await Promise.race([entered.promise.then(() => true), settled.then(() => false)]),
          "Library preparation did not yield",
        ).toBe(true);
        process.env.OPENCLAW_STATE_DIR = otherRoot;
        test.pin.revision = test.updated.entry.revision;
        test.pin.name = "changed-during-preparation";
        test.loadOptions.librarySelections.push({
          ...test.pin,
          name: "added-during-preparation",
        });
        await writeSkill({
          dir: path.join(test.workspaceDir, "skills", "arrived"),
          name: "arrived",
          description: "Arrived during preparation",
        });
        bumpSkillsSnapshotVersion({ workspaceDir: test.workspaceDir, reason: "manual" });
        gate.resolve();
        const entries = await pending;
        expect(entries.map(({ skill }) => skill.name)).toEqual(["arrived", originalPin.name]);
        expect(entries[1]?.skill.description).toBe("Saved procedure");
        expect(entries[1]?.skill.filePath).toBe(
          path.join(
            test.root,
            "skill-library",
            originalPin.skillId,
            "revisions",
            originalPin.revision,
            "SKILL.md",
          ),
        );
        expect(fs.readFileSync(entries[1]!.skill.filePath, "utf8")).toBe(content);
        expect(fs.existsSync(path.join(otherRoot, "state", "openclaw.sqlite"))).toBe(false);
      } finally {
        gate.resolve();
        await settled;
      }
    });
  },
);

it.each([
  { surface: "workspace", warm: false },
  { surface: "workspace", warm: true },
  { surface: "prompt", warm: false },
  { surface: "prompt", warm: true },
] as const)(
  "$surface refuses an invalidated caller after Library preparation (warm=$warm)",
  async ({ surface, warm }) => {
    const test = await fixture();
    await test.run(async () => {
      if (warm) {
        await prepare(surface, test);
      }
      const entered = createDeferredCore();
      const gate = createDeferredCore();
      const original = librarySelection.prepareSkillLibrarySelection;
      vi.spyOn(librarySelection, "prepareSkillLibrarySelection").mockImplementationOnce(
        async (...args) => {
          const entries = await original(...args);
          entered.resolve();
          await gate.promise;
          return entries;
        },
      );
      const closed = new Error("Synthetic Library caller was invalidated");
      let current = true;
      const pending = prepare(surface, test, () => {
        if (!current) {
          throw closed;
        }
      });
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(
          await Promise.race([entered.promise.then(() => true), settled.then(() => false)]),
          "Library preparation did not yield",
        ).toBe(true);
        current = false;
        gate.resolve();
        expect(await settled).toEqual({ error: closed });
      } finally {
        gate.resolve();
        await settled;
      }
    });
  },
);
