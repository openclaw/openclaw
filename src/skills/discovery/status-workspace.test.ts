import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  formatSkillInfo,
  formatSkillsCheck,
  formatSkillsList,
} from "../../cli/skills-cli.format.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { closeSkillsWatchers, refreshSkillsDiscovery } from "../runtime/refresh.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { buildWorkspaceSkillStatus, prepareWorkspaceSkillStatus } from "./status.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Settle discovery before removing its fixture roots.
    await closeSkillsWatchers(true);
    cleanup();
  }),
);
const createTempWorkspaceDir = () => tempDirs.make("openclaw-skill-status-");

function makeEntry(
  name: string,
  metadata?: SkillEntry["metadata"],
  source = "openclaw-workspace",
): SkillEntry {
  return { ...createFixtureSkillEntry(name, { source }), metadata };
}

function requireReportedSkill(report: ReturnType<typeof buildWorkspaceSkillStatus>, name: string) {
  return report.skills.find((entry) => entry.name === name);
}

describe("buildWorkspaceSkillStatus", () => {
  it("reports rejected skills through cached inventory and CLI output until they are repaired", async () => {
    const workspaceDir = createTempWorkspaceDir();
    const brokenFile = path.join(workspaceDir, "skills", "broken", "SKILL.md");
    const validFile = path.join(workspaceDir, "skills", "valid", "SKILL.md");
    const escapedDir = path.join(workspaceDir, "skills", "escaped");
    const outsideDir = path.join(workspaceDir, "outside");
    await fs.mkdir(path.dirname(brokenFile), { recursive: true });
    await fs.mkdir(path.dirname(validFile), { recursive: true });
    await fs.mkdir(outsideDir);
    await fs.writeFile(
      path.join(outsideDir, "SKILL.md"),
      "---\nname: outside\ndescription: Outside the configured root\n---\n",
    );
    await fs.symlink(outsideDir, escapedDir, process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(
      brokenFile,
      "---\nname: broken\ndescription: First line\ncontinued at column zero\n---\n",
    );
    await fs.writeFile(validFile, "---\nname: valid\ndescription: A valid sibling\n---\n");
    const options = { managedSkillsDir: path.join(workspaceDir, "managed") };
    // Runtime discovery may populate the cache before the operator requests status.
    loadWorkspaceSkills(workspaceDir, options);
    const prepared = await prepareWorkspaceSkillStatus(workspaceDir, options);
    for (const report of [buildWorkspaceSkillStatus(workspaceDir, options), prepared.report]) {
      expect(report.skills.map((skill) => skill.name)).toContain("valid");
      expect(report.skills.map((skill) => skill.name)).not.toContain("broken");
      expect(report.skills.map((skill) => skill.name)).not.toContain("outside");
      expect(report).toMatchObject({
        diagnostics: {
          items: [
            {
              kind: "invalid",
              path: escapedDir,
              message: "Skill path resolves outside its configured root.",
            },
            expect.objectContaining({
              kind: "invalid",
              path: brokenFile,
              message: expect.stringContaining("invalid frontmatter: MISSING_CHAR"),
            }),
          ],
          omitted: 0,
        },
      });
      for (const json of [false, true]) {
        for (const output of [
          formatSkillsList(report, { json }),
          formatSkillsCheck(report, { json }),
          formatSkillInfo(report, "broken", { json }),
        ]) {
          expect(output).toContain("broken/SKILL.md");
          expect(output).toContain("invalid frontmatter: MISSING_CHAR");
          expect(output).toContain("Skill path resolves outside its configured root.");
        }
      }
    }
    await fs.writeFile(brokenFile, "---\nname: broken\ndescription: Repaired skill\n---\n");
    await fs.unlink(escapedDir);
    await refreshSkillsDiscovery({ workspaceDir });
    const { report } = await prepareWorkspaceSkillStatus(workspaceDir, options);
    expect(report.skills.map((skill) => skill.name)).toContain("broken");
    expect(report).not.toHaveProperty("diagnostics");
  });

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
      expect(report.skills.map((skill) => skill.install.map((option) => option.id))).toEqual([
        [expectedId],
      ]);
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
    expect(requireReportedSkill(report, "hot-reload-probe")).toMatchObject({ disabled: true });
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

  it("does not mark an unknown-source skill as bundled by bundled name alone", async () => {
    const bundledDir = tempDirs.make("openclaw-bundled-");
    await writeSkill({
      dir: path.join(bundledDir, "peekaboo"),
      name: "peekaboo",
      description: "Bundled peekaboo",
    });

    await withEnvAsync({ OPENCLAW_BUNDLED_SKILLS_DIR: bundledDir }, async () => {
      const report = buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [makeEntry("peekaboo", undefined, "unknown")],
        config: { skills: { allowBundled: ["other-skill"] } },
      });
      const skill = requireReportedSkill(report, "peekaboo");

      expect(skill).toMatchObject({
        source: "unknown",
        bundled: false,
        blockedByAllowlist: false,
        eligible: true,
      });
    });
  });

  it("filters install options by OS", () => {
    const entry = makeEntry("install-skill", {
      requires: { bins: ["missing-bin"] },
      install: ["darwin", "linux", "win32"].map((os) => ({
        id: os,
        kind: "download",
        os: [os],
        url: `https://example.com/${os}.tar.bz2`,
      })),
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
      }),
    );
    expect(report.skills.map((skill) => skill.install.map((option) => option.id))).toEqual([
      ["darwin", "linux", "win32"].includes(process.platform) ? [process.platform] : [],
    ]);
  });
});
