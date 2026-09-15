import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { loadSkillLibrarySelection, seedSkillLibrarySelection } from "../library/selection.js";
import { saveSkillLibrary } from "../library/service.js";
import type { SkillLibraryAuthority } from "../library/store.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import {
  acquireWorkspaceSkills,
  type PublishedWorkspaceSkills,
} from "./workspace-skill-sync.runtime.js";

it.each([false, true])(
  "retains pinned library bytes and companions across default changes (hidden=%s)",
  async (hidden) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-library-lifetime-"));
    const publications: PublishedWorkspaceSkills[] = [];
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const options = { path: path.join(root, "state", "openclaw.sqlite"), env: process.env };
        const profile = ensureProfileForEmail("catalog-owner@example.test", options);
        const authority: SkillLibraryAuthority = {
          profileId: profile.id,
          scopes: ["operator.read", "operator.write"],
          getConfig: () => ({}),
          assertCurrent: () => {},
        };
        const content = (version: string) =>
          `---\nname: guide\ndescription: ${version}\n${hidden ? "disable-model-invocation: true\n" : ""}---\n${version}\n`;
        const saved = await saveSkillLibrary(
          authority,
          {
            slug: "guide",
            content: content("A"),
            expectedRevision: null,
            files: [{ path: "companion.txt", content: "A" }],
          },
          options,
        );
        const pins = seedSkillLibrarySelection(authority, options);
        const snapshot = {
          ...(await buildSkillSnapshot(root, {
            entries: loadSkillLibrarySelection(pins, options),
          })),
          librarySelections: pins,
        };
        const changed = await saveSkillLibrary(
          authority,
          {
            slug: "guide",
            skillId: saved.entry.skillId,
            expectedRevision: saved.entry.revision,
            content: content("B"),
            files: [{ path: "companion.txt", content: "B" }],
          },
          options,
        );
        expect(changed.entry.revision).not.toBe(saved.entry.revision);
        const publication = await acquireWorkspaceSkills({
          sourceWorkspaceDir: path.join(root, "workspace"),
          targetWorkspaceDir: path.join(root, "sandbox"),
          managedSkillsDir: path.join(root, "managed"),
          bundledSkillsDir: path.join(root, "bundled"),
          skillsSnapshot: snapshot,
        });
        publications.push(publication);
        const usage = publication.skillUsagePaths.find(
          (skill) => skill.skillName === pins[0]!.name,
        );
        expect(usage).toBeDefined();
        expect(await fs.readFile(usage!.readPath, "utf8")).toBe(content("A"));
        expect(
          await fs.readFile(path.join(path.dirname(usage!.readPath), "companion.txt"), "utf8"),
        ).toBe("A");
        expect(publication.skillsSnapshot.librarySelections).toEqual(pins);
        if (hidden) {
          expect(publication.skillsSnapshot.prompt).toBe("");
        } else {
          expect(publication.skillsSnapshot.prompt).toContain("<description>A</description>");
        }
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      await Promise.all(publications.map((p) => p.release()));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
