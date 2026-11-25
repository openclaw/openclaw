import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { readInstalledSkill } from "../../agents/installed-skill-catalog.js";
import { prepareInstalledSkillCatalog } from "../../agents/installed-skill-runtime.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { closeSkillsWatchers, prepareLocalSkillSources } from "./refresh.js";

try {
  for (const [index, mode] of (["off", "require", "off"] as const).entries()) {
    const directory = path.join(process.argv[2]!, String(index));
    const filePath = path.join(directory, "SKILL.md");
    await fs.mkdir(directory);
    await fs.writeFile(
      filePath,
      "---\nname: guide\ndescription: Synthetic guide\n---\nInstructions\n",
    );
    await fs.writeFile(path.join(directory, "companion.md"), "Synthetic companion");
    const skill = createCanonicalFixtureSkill({
      name: "guide",
      description: "Synthetic guide",
      filePath,
      baseDir: directory,
      source: "bundled",
    });
    for (const discovery of [false, true]) {
      configureFsSafeNative({ mode });
      const entries = discovery
        ? (
            await prepareLocalSkillSources(
              {
                sourcePlan: {
                  workspaceDir: directory,
                  roots: [{ dir: directory, source: "openclaw-workspace", tier: "workspace" }],
                  managedSkillsDir: directory,
                  pluginSkillRoots: [],
                },
                limits: resolveSkillDiscoveryLimits(),
                additionalBins: [],
              },
              { watch: false },
            )
          ).entries
        : [{ skill, frontmatter: {} }];
      const snapshot = await buildSkillSnapshot(directory, { entries });
      // A later permissive read cannot revive preparation refused by its original policy.
      configureFsSafeNative({ mode: "off" });
      const catalog = prepareInstalledSkillCatalog({ snapshot, workspaceDir: directory });
      const content = await readInstalledSkill(catalog, "guide", undefined, "companion.md").then(
        (read) => read.content,
        () => undefined,
      );
      assert.equal(
        content,
        mode === "off" ? "Synthetic companion" : undefined,
        `${mode}/${discovery}`,
      );
    }
  }
} finally {
  await closeSkillsWatchers();
}
