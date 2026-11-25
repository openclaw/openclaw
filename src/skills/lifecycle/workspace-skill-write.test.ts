import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  prepareWorkspaceSkillRestoration,
  restoreWorkspaceSkillMutation,
} from "./workspace-skill-write.js";

const tempDirs = createTrackedTempDirs();
afterEach(() => tempDirs.cleanup());

async function mutationPaths() {
  const workspaceDir = await fs.realpath(await tempDirs.make("openclaw-skill-restore-"));
  const skillDir = path.join(workspaceDir, "skills", "fixture");
  const skillFile = path.join(skillDir, "SKILL.md");
  const supportFile = path.join(skillDir, "references", "proof.md");
  await fs.mkdir(path.dirname(supportFile), { recursive: true });
  return { workspaceDir, skillDir, skillFile, supportFile };
}

it.each([
  ["create", null, null],
  ["update", "# Before\n", "before support\n"],
] as const)(
  "restores an interrupted %s from persisted rollback facts",
  async (mode, previousContent, previousSupport) => {
    const { workspaceDir, skillDir, skillFile, supportFile } = await mutationPaths();
    await fs.writeFile(skillFile, "# Proposed\n", "utf8");
    await fs.writeFile(supportFile, "proposed support\n", "utf8");
    const restoration = await prepareWorkspaceSkillRestoration({
      skillsRoot: workspaceDir,
      skillDir,
      skillFile,
      previousContent,
      mode,
      proposedContentHash: sha256Hex("# Proposed\n"),
      supportFiles: [
        {
          path: "references/proof.md",
          previousContent: previousSupport,
          proposedContentHash: sha256Hex("proposed support\n"),
        },
      ],
    });
    await restoreWorkspaceSkillMutation(restoration);
    for (const [file, previous] of [
      [skillFile, previousContent],
      [supportFile, previousSupport],
    ] as const) {
      if (previous === null) {
        await expect(fs.access(file)).rejects.toThrow();
      } else {
        await expect(fs.readFile(file, "utf8")).resolves.toBe(previous);
      }
    }
  },
);

it("refuses to restore over an external edit", async () => {
  const { workspaceDir, skillDir, skillFile } = await mutationPaths();
  await fs.writeFile(skillFile, "# External edit\n", "utf8");
  const restoration = await prepareWorkspaceSkillRestoration({
    skillsRoot: workspaceDir,
    skillDir,
    skillFile,
    previousContent: null,
    proposedContentHash: sha256Hex("# Proposed\n"),
    mode: "create",
  });
  await expect(restoreWorkspaceSkillMutation(restoration)).rejects.toThrow(
    "Failed to restore the previous workspace skill state.",
  );
  await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# External edit\n");
});
