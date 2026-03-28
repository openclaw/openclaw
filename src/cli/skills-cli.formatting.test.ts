import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSyntheticSourceInfo } from "@mariozechner/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import type { SkillEntry } from "../agents/skills.js";
import { captureEnv } from "../test-utils/env.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

describe("skills-cli (e2e)", () => {
  let tempWorkspaceDir = "";
  let tempBundledDir = "";
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(() => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_SKILLS_DIR"]);
    tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skills-test-"));
    tempBundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-skills-test-"));
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = tempBundledDir;
  });

  afterAll(() => {
    if (tempWorkspaceDir) {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    }
    if (tempBundledDir) {
      fs.rmSync(tempBundledDir, { recursive: true, force: true });
    }
    envSnapshot.restore();
  });

  function createEntries(): SkillEntry[] {
    const baseDir = path.join(tempWorkspaceDir, "peekaboo");
    return [
      {
        skill: createFixtureSkill({
          name: "peekaboo",
          description: "Capture UI screenshots",
          filePath: path.join(baseDir, "SKILL.md"),
          baseDir,
          source: "openclaw-bundled",
        }),
        frontmatter: {},
        metadata: { emoji: "📸" },
      },
    ];
  }

  it("loads bundled skills and formats them", () => {
    const entries = createEntries();
    const report = buildWorkspaceSkillStatus(tempWorkspaceDir, {
      managedSkillsDir: "/nonexistent",
      entries,
    });

    expect(report.skills.length).toBeGreaterThan(0);

    const listOutput = formatSkillsList(report, {});
    expect(listOutput).toContain("Skills");

    const checkOutput = formatSkillsCheck(report, {});
    expect(checkOutput).toContain("Total:");

    const jsonOutput = formatSkillsList(report, { json: true });
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.skills).toBeInstanceOf(Array);
  });

  it("formats info for a real bundled skill (peekaboo)", () => {
    const entries = createEntries();
    const report = buildWorkspaceSkillStatus(tempWorkspaceDir, {
      managedSkillsDir: "/nonexistent",
      entries,
    });

    const peekaboo = report.skills.find((s) => s.name === "peekaboo");
    if (!peekaboo) {
      throw new Error("peekaboo fixture skill missing");
    }

    const output = formatSkillInfo(report, "peekaboo", {});
    expect(output).toContain("peekaboo");
    expect(output).toContain("Details:");
  });
});

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
}): SkillEntry["skill"] {
  return {
    name: params.name,
    description: params.description,
    filePath: params.filePath,
    baseDir: params.baseDir,
    sourceInfo: createSyntheticSourceInfo(params.filePath, { source: params.source }),
    disableModelInvocation: false,
  };
}
