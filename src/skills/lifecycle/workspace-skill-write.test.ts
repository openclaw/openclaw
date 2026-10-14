import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  prepareWorkspaceSkillRestoration,
  restoreWorkspaceSkillMutation,
} from "./workspace-skill-write.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function mutationPaths(slug: string) {
  const workspaceDir = await fs.realpath(await tempDirs.make(`openclaw-skill-${slug}-`));
  const skillDir = path.join(workspaceDir, "skills", slug);
  return {
    workspaceDir,
    skillDir,
    skillFile: path.join(skillDir, "SKILL.md"),
    supportFile: path.join(skillDir, "references", "proof.md"),
  };
}

describe("workspace skill mutations", () => {
  it("removes every file from a restored create", async () => {
    const { workspaceDir, skillDir, skillFile, supportFile } =
      await mutationPaths("reversible-create");
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(skillFile, "# Created\n", "utf8");
    await fs.writeFile(supportFile, "created support\n", "utf8");
    const restoration = await prepareWorkspaceSkillRestoration({
      skillsRoot: workspaceDir,
      skillDir,
      skillFile,
      previousContent: null,
      proposedContentHash: sha256Hex("# Created\n"),
      supportFiles: [
        {
          path: "references/proof.md",
          previousContent: null,
          proposedContentHash: sha256Hex("created support\n"),
        },
      ],
      mode: "create",
    });

    await restoreWorkspaceSkillMutation(restoration);

    await expect(fs.access(skillFile)).rejects.toThrow();
    await expect(fs.access(supportFile)).rejects.toThrow();
  });

  it("restores an interrupted update from persisted rollback facts", async () => {
    const { workspaceDir, skillDir, skillFile, supportFile } =
      await mutationPaths("recovered-update");
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(skillFile, "# Partial update\n", "utf8");
    await fs.writeFile(supportFile, "partial support\n", "utf8");

    const restoration = await prepareWorkspaceSkillRestoration({
      skillsRoot: workspaceDir,
      skillDir,
      skillFile,
      previousContent: "# Before\n",
      proposedContentHash: sha256Hex("# Partial update\n"),
      supportFiles: [
        {
          path: "references/proof.md",
          previousContent: "before support\n",
          proposedContentHash: sha256Hex("partial support\n"),
        },
      ],
      mode: "update",
    });
    await restoreWorkspaceSkillMutation(restoration);

    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe("# Before\n");
    await expect(fs.readFile(supportFile, "utf8")).resolves.toBe("before support\n");
  });

  it("refuses to restore over an external edit", async () => {
    const { workspaceDir, skillDir, skillFile } = await mutationPaths("external-edit");
    await fs.mkdir(skillDir, { recursive: true });
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
});
