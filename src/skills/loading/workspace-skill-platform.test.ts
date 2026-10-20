import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import { collectRequiredBins } from "../runtime/remote-probe-utils.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { OpenClawSkillMetadata } from "../types.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeSkillsWatchers(true);
    cleanup();
  }),
);

async function createPlatformSkills() {
  const workspaceDir = tempDirs.make("openclaw-skill-platform-");
  const fixtures: Array<[string, OpenClawSkillMetadata]> = [
    ["alias", { os: ["macos"], requires: { bins: ["mac-tool"] } }],
    ["canonical", { os: ["darwin"], requires: { anyBins: ["mac-alternative"] } }],
    ["always", { os: [" MacOS "], always: true, requires: { bins: ["missing-tool"] } }],
    ["unsupported", { os: ["unsupported-platform"], always: true }],
  ];
  for (const [name, metadata] of fixtures) {
    await writeSkill({
      dir: path.join(workspaceDir, "skills", name),
      name,
      description: `${name} platform fixture`,
      metadata: JSON.stringify({
        openclaw: {
          ...metadata,
          install: [
            { id: "mac-recipe", kind: "download", os: ["macos"], url: "https://example.com/tool" },
            {
              id: "linux-recipe",
              kind: "download",
              os: ["linux"],
              url: "https://example.com/tool",
            },
          ],
        },
      }),
    });
  }
  return { workspaceDir, entries: loadWorkspaceSkills(workspaceDir, { workspaceOnly: true }) };
}

describe("skill OS compatibility", () => {
  it.each([
    { platform: "darwin", remotePlatforms: [], compatible: true, installable: true },
    { platform: " Darwin ", remotePlatforms: [], compatible: true, installable: true },
    { platform: "linux", remotePlatforms: ["darwin"], compatible: true, installable: false },
    { platform: "linux", remotePlatforms: [], compatible: false, installable: false },
    { platform: "win32", remotePlatforms: [], compatible: false, installable: false },
  ])(
    "keeps status and runtime prompt aligned on $platform with remote $remotePlatforms",
    async ({ platform, remotePlatforms, compatible, installable }) => {
      const { workspaceDir, entries } = await createPlatformSkills();
      // Synthetic workspace-host facts exercise the real loader without requiring that OS.
      const runtime = { platform, bins: ["mac-tool", "mac-alternative"] };
      const eligibility = {
        remote: { platforms: remotePlatforms, hasBin: () => false, hasAnyBin: () => false },
      };
      const release = registerAgentWorkspaceAccess(workspaceDir, {
        loadSkills: async () => ({ entries, executionEntries: [], runtime }),
        bridge: {
          readFile: async () => Buffer.from("unused"),
          writeFile: async () => {},
          stat: async () => null,
        },
      });
      try {
        const config = { plugins: { enabled: false } };
        const report = buildWorkspaceSkillStatus(workspaceDir, {
          entries,
          files: [],
          runtime,
          eligibility,
          config,
        });
        const snapshot = await buildSkillSnapshot(workspaceDir, {
          config,
          eligibility,
          managedSkillsDir: path.join(workspaceDir, ".managed"),
          bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        });
        const expected = compatible ? ["alias", "always", "canonical"] : [];
        expect(
          report.skills.filter((skill) => skill.modelVisible).map((skill) => skill.name),
        ).toEqual(expected);
        expect(snapshot.skills.map((skill) => skill.name)).toEqual(expected);
        for (const name of expected) {
          expect(snapshot.prompt).toContain(`<name>${name}</name>`);
        }
        expect(snapshot.prompt).not.toContain("<name>unsupported</name>");
        const alias = report.skills.find((skill) => skill.name === "alias");
        expect(alias?.missing.os).toEqual(compatible ? [] : ["macos"]);
        expect(alias?.install.map((option) => option.id)).toEqual(
          installable ? ["mac-recipe"] : [],
        );
      } finally {
        release();
      }
    },
  );

  it("includes alias requirements when preparing a Darwin node binary probe", async () => {
    const { entries } = await createPlatformSkills();
    expect(collectRequiredBins(entries, "darwin")).toEqual([
      "mac-tool",
      "missing-tool",
      "mac-alternative",
    ]);
    expect(collectRequiredBins(entries, "linux")).toEqual([]);
  });
});
