import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { closeSkillsWatchers } from "../runtime/refresh.js";
import { collectRequiredBins } from "../runtime/remote-probe-utils.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
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
  const fixtures = [
    ["alias", { os: ["macos"], requires: { bins: ["mac-tool"] } }],
    ["canonical", { os: ["darwin"], requires: { anyBins: ["mac-alternative"] } }],
    ["always", { os: [" MacOS "], always: true, requires: { bins: ["missing-tool"] } }],
    ["unsupported", { os: ["unsupported-platform"], always: true }],
  ] as const;
  const install = (
    [
      ["mac-recipe", "macos"],
      ["linux-recipe", "linux"],
    ] as const
  ).map(([id, os]) => ({
    id,
    kind: "download",
    os: [os],
    url: "https://example.com/tool",
  }));
  for (const [name, metadata] of fixtures) {
    await writeSkill({
      dir: path.join(workspaceDir, "skills", name),
      name,
      description: `${name} platform fixture`,
      metadata: JSON.stringify({ openclaw: { ...metadata, install } }),
    });
  }
  return { workspaceDir, entries: loadWorkspaceSkills(workspaceDir, { workspaceOnly: true }) };
}

it.each([
  { platform: "darwin", remotePlatforms: [], compatible: true, installable: true },
  { platform: " Darwin ", remotePlatforms: [], compatible: true, installable: true },
  { platform: "linux", remotePlatforms: ["darwin"], compatible: true, installable: false },
  { platform: "linux", remotePlatforms: [], compatible: false, installable: false },
  { platform: "win32", remotePlatforms: [], compatible: false, installable: false },
])(
  "aligns status and prompt on $platform with remote $remotePlatforms",
  async ({ platform, remotePlatforms, compatible, installable }) => {
    const { workspaceDir, entries } = await createPlatformSkills();
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
      const options = {
        config: { plugins: { enabled: false } },
        eligibility,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      };
      const report = buildWorkspaceSkillStatus(workspaceDir, {
        ...options,
        entries,
        files: [],
        runtime,
      });
      const snapshot = await buildSkillSnapshot(workspaceDir, options);
      const expected = compatible ? ["alias", "always", "canonical"] : [];
      expect(
        report.skills.filter((skill) => skill.modelVisible).map((skill) => skill.name),
      ).toEqual(expected);
      expect(snapshot.skills.map((skill) => skill.name)).toEqual(expected);
      for (const name of expected) {
        expect(snapshot.prompt).toContain(`<name>${name}</name>`);
      }
      expect(snapshot.prompt).not.toContain("<name>unsupported</name>");
      expect(report.skills.find((skill) => skill.name === "alias")).toMatchObject({
        missing: { os: compatible ? [] : ["macos"] },
        install: installable ? [{ id: "mac-recipe" }] : [],
      });
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
