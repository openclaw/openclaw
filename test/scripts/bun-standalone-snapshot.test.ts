import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { copyStandaloneRuntime } from "../../scripts/lib/bun-standalone-snapshot.mjs";
import { discoverSkillCandidates } from "../../src/skills/loading/skill-root-discovery.js";
import { resolveWorkspaceSkillSourcePlan } from "../../src/skills/loading/workspace-skill-sources.js";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

// mock-isolation: prepared plugin roots must not discover installed plugins or load registries.
vi.mock("../../src/skills/loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => {
    throw new Error("Unexpected plugin discovery");
  },
  resolvePluginSkillRootsFromMetadata: () => {
    throw new Error("Unexpected plugin discovery from metadata");
  },
}));

it("packages custodian skills at the owning agent's standalone source root", async () => {
  await withTempDir("openclaw-standalone-skills-", async (root) => {
    const sourceRoot = path.join(root, "source");
    const runtimeRoot = path.join(root, "runtime");
    for (const directory of [
      "dist",
      "node_modules",
      "packages",
      "extensions",
      "skills/example",
      "custodian-skills/diagnose-gateway",
      "docs/reference/templates",
      "scripts",
    ]) {
      fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    }
    for (const filename of [
      "package.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "scripts/windows-cmd-helpers.mjs",
    ]) {
      fs.writeFileSync(path.join(sourceRoot, filename), "fixture\n");
    }
    fs.writeFileSync(path.join(sourceRoot, "skills/example/SKILL.md"), "Example skill\n");
    const skillText = "---\nname: diagnose-gateway\ndescription: Synthetic custodian skill\n---\n";
    fs.writeFileSync(
      path.join(sourceRoot, "custodian-skills/diagnose-gateway/SKILL.md"),
      skillText,
    );

    copyStandaloneRuntime(sourceRoot, runtimeRoot);
    const plan = resolveWorkspaceSkillSourcePlan(path.join(root, "workspace"), {
      config: { agents: { entries: { main: {} } } },
      agentId: "main",
      bundledSkillsDir: path.join(runtimeRoot, "skills"),
      managedSkillsDir: path.join(root, "managed"),
      pluginSkillsDir: path.join(root, "plugin-skills"),
      pluginSkillRoots: [],
    });
    const candidates = plan.roots
      .filter((entry) => entry.source === "openclaw-custodian")
      .flatMap(
        (entry) =>
          discoverSkillCandidates({
            dir: entry.dir,
            source: entry.source,
            limits: {
              maxCandidatesPerRoot: 10,
              maxSkillsLoadedPerSource: 10,
              maxSkillFileBytes: 1024,
            },
            allowedSymlinkTargetRealPaths: [],
          }).candidates,
      );
    expect(
      candidates.map(({ name, skillDir }) => ({
        name,
        skillDir,
        content: fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8"),
      })),
    ).toEqual([
      {
        name: "diagnose-gateway",
        skillDir: path.join(runtimeRoot, "custodian-skills/diagnose-gateway"),
        content: skillText,
      },
    ]);
  });
});
