import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { buildWorkspaceSkillStatus } from "./status.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
const createTempWorkspaceDir = () => tempDirs.make("openclaw-skill-status-");

function makeEntry(
  name: string,
  metadata?: SkillEntry["metadata"],
  source = "openclaw-workspace",
): SkillEntry {
  const baseDir = `/tmp/${name}`;
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: `desc:${name}`,
      filePath: `${baseDir}/SKILL.md`,
      baseDir,
      source,
    }),
    frontmatter: {},
    metadata,
  };
}

function requireReportedSkill(report: ReturnType<typeof buildWorkspaceSkillStatus>, name: string) {
  const skill = report.skills.find((entry) => entry.name === name);
  if (!skill) {
    throw new Error(`reported skill ${name} missing`);
  }
  return skill;
}

describe("buildWorkspaceSkillStatus", () => {
  it.each([
    [false, true, ["brew", "node", "uv"], "uv-2"],
    [false, true, ["go", "brew", "download"], "brew-1"],
    [true, false, ["brew", "download", "go"], "go-2"],
  ] as const)(
    "preserves installer preference (prefer brew: %s, available: %s, kinds: %j)",
    async (preferBrew, brewAvailable, kinds, expectedId) => {
      const workspaceDir = createTempWorkspaceDir();
      if (brewAvailable) {
        await fs.writeFile(path.join(workspaceDir, "brew"), "", { mode: 0o755 });
      }
      const entry = makeEntry("installer-preference", {
        install: kinds.map((kind) => ({ kind })),
      });
      const report = withEnv({ PATH: brewAvailable ? workspaceDir : "" }, () =>
        buildWorkspaceSkillStatus(workspaceDir, {
          entries: [entry],
          config: { skills: { install: { preferBrew } } },
        }),
      );
      expect(
        requireReportedSkill(report, entry.skill.name).install.map((option) => option.id),
      ).toEqual([expectedId]);
    },
  );

  it("keeps config-disabled skills visible in status when eligibility is passed", async () => {
    const workspaceDir = createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills"),
      name: "hot-reload-probe",
      description: "Lifecycle probe",
    });

    // Regression: skills.status passes eligibility (node-skill merge); the
    // loader must stay unfiltered so disabled skills still report with flags.
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: { skills: { entries: { "hot-reload-probe": { enabled: false } } } },
      eligibility: { nodeSkills: { canExec: false } },
    });
    const skill = requireReportedSkill(report, "hot-reload-probe");

    expect(skill.disabled).toBe(true);
  });

  it("requires explicit enablement before exposing bundled coding-agent", async () => {
    const workspaceDir = createTempWorkspaceDir();
    const config = { skills: { allowBundled: ["coding-agent"] } };
    const entries = loadWorkspaceSkills(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.resolve("skills"),
      config,
    });
    const codingAgent = entries.find((entry) => entry.skill.name === "coding-agent");
    if (!codingAgent) {
      throw new Error("skill entry coding-agent missing");
    }

    const eligibility = {
      remote: {
        platforms: [process.platform],
        hasBin: () => false,
        hasAnyBin: (bins: string[]) => bins.includes("codex"),
      },
    };
    const read = (enabled = false) =>
      withEnv(
        { PATH: "" },
        () =>
          buildWorkspaceSkillStatus(workspaceDir, {
            entries: [codingAgent],
            eligibility,
            config: enabled
              ? { skills: { ...config.skills, entries: { "coding-agent": { enabled: true } } } }
              : config,
          }).skills[0],
      );
    expect(read()).toMatchObject({
      eligible: false,
      requirements: { config: ["skills.entries.coding-agent.enabled"] },
      missing: { config: ["skills.entries.coding-agent.enabled"] },
    });
    expect(read(true)).toMatchObject({ eligible: true, missing: { config: [] } });
  });

  it.each(["unknown"])(
    "does not mark a %s skill as bundled by bundled name alone",
    async (source) => {
      const bundledDir = tempDirs.make("openclaw-bundled-");
      await writeSkill({
        dir: path.join(bundledDir, "peekaboo"),
        name: "peekaboo",
        description: "Bundled peekaboo",
      });

      await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundledDir }, async () => {
        const report = buildWorkspaceSkillStatus("/tmp/ws", {
          entries: [makeEntry("peekaboo", undefined, source)],
          config: { skills: { allowBundled: ["other-skill"] } },
        });
        const skill = requireReportedSkill(report, "peekaboo");

        expect(skill).toMatchObject({
          source,
          bundled: false,
          blockedByAllowlist: false,
          eligible: true,
        });
      });
    },
  );

  it("filters install options by OS", () => {
    const entry = makeEntry("install-skill", {
      requires: { bins: ["missing-bin"] },
      install: (
        [
          ["mac", "darwin"],
          ["linux", "linux"],
          ["win", "win32"],
        ] as const
      ).map(([id, os]) => ({
        id,
        kind: "download",
        os: [os],
        url: `https://example.com/${id}.tar.bz2`,
      })),
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
      }),
    );
    const skill = requireReportedSkill(report, "install-skill");

    if (process.platform === "darwin") {
      expect(skill.install.map((opt) => opt.id)).toEqual(["mac"]);
    } else if (process.platform === "linux") {
      expect(skill.install.map((opt) => opt.id)).toEqual(["linux"]);
    } else if (process.platform === "win32") {
      expect(skill.install.map((opt) => opt.id)).toEqual(["win"]);
    } else {
      expect(skill.install).toStrictEqual([]);
    }
  });
});
