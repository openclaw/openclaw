import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
} from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { copyStandaloneRuntime } from "../../scripts/lib/bun-standalone-snapshot.mjs";
import { resolveOpenClawReferencePaths } from "../../src/agents/docs-path.js";
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

it("packages docs and custodian skills at their standalone source roots", async () => {
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
      "docs/reference/templates/roles/presets",
      "docs/reference/templates/roles/coordinator/workspace",
      "docs/internal/nested",
      "scripts",
    ]) {
      fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    }
    for (const filename of [
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "scripts/windows-cmd-helpers.mjs",
    ]) {
      fs.writeFileSync(path.join(sourceRoot, filename), "fixture\n");
    }
    fs.writeFileSync(path.join(sourceRoot, "package.json"), '{"name":"openclaw"}\n');
    fs.writeFileSync(path.join(sourceRoot, "docs/docs.json"), "{}\n");
    fs.writeFileSync(path.join(sourceRoot, "docs/start.md"), "Start documentation\n");
    fs.writeFileSync(path.join(sourceRoot, "docs/deploy.mdx"), "Deployment documentation\n");
    const preset = '{"schemaVersion":1,"coordinator":{"id":"coordinator","role":"coordinator"}}\n';
    const template = "Public workspace instructions\n";
    fs.writeFileSync(
      path.join(sourceRoot, "docs/reference/templates/roles/presets/team.json"),
      preset,
    );
    fs.writeFileSync(
      path.join(sourceRoot, "docs/reference/templates/roles/coordinator/workspace/AGENTS.md"),
      template,
    );
    const privateDocs = ["docs/internal/nested/runbook.md", "docs/AGENTS.md", "docs/CLAUDE.md"];
    for (const filename of privateDocs) {
      fs.writeFileSync(path.join(sourceRoot, filename), "Private authoring fixture\n");
    }
    fs.writeFileSync(path.join(sourceRoot, "skills/example/SKILL.md"), "Example skill\n");
    const skillText = "---\nname: diagnose-gateway\ndescription: Synthetic custodian skill\n---\n";
    fs.writeFileSync(
      path.join(sourceRoot, "custodian-skills/diagnose-gateway/SKILL.md"),
      skillText,
    );

    copyStandaloneRuntime(sourceRoot, runtimeRoot);
    for (const filename of privateDocs) {
      expect(fs.existsSync(path.join(runtimeRoot, filename))).toBe(false);
    }
    pruneStandaloneRuntime(planStandaloneRuntime(runtimeRoot));
    expect(
      fs.readFileSync(
        path.join(runtimeRoot, "docs/reference/templates/roles/presets/team.json"),
        "utf8",
      ),
    ).toBe(preset);
    expect(
      fs.readFileSync(
        path.join(runtimeRoot, "docs/reference/templates/roles/coordinator/workspace/AGENTS.md"),
        "utf8",
      ),
    ).toBe(template);
    expect(
      await resolveOpenClawReferencePaths({
        argv1: path.join(runtimeRoot, "openclaw.mjs"),
        cwd: runtimeRoot,
      }),
    ).toEqual({ docsPath: path.join(runtimeRoot, "docs"), sourcePath: null });
    expect(fs.readFileSync(path.join(runtimeRoot, "docs/start.md"), "utf8")).toBe(
      "Start documentation\n",
    );
    expect(fs.readFileSync(path.join(runtimeRoot, "docs/deploy.mdx"), "utf8")).toBe(
      "Deployment documentation\n",
    );
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
