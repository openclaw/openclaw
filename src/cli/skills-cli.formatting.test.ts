import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import { writeWorkspaceSkills } from "../skills/test-support/e2e-test-helpers.js";
import { captureEnv } from "../test-utils/env.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
describe("skills descriptor formatting", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  beforeAll(() => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_SKILLS_DIR"]);
    process.env.OPENCLAW_BUNDLED_SKILLS_DIR = tempDirs.make("openclaw-bundled-skills-test-");
  });
  afterAll(() => envSnapshot.restore());

  it("keeps C1 tab-separated descriptions in their table cell", async () => {
    const description = "left\x9b31\tmright\x9b0m";
    const workspaceDir = tempDirs.make("tab-spacing-");
    await writeWorkspaceSkills(workspaceDir, [
      {
        name: "tab-spacing",
        description: JSON.stringify(description).replaceAll("\x9b", "\\u009b"),
      },
    ]);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, "managed"),
      config: { plugins: { enabled: false } },
    });
    expect(report.skills.find((skill) => skill.name === "tab-spacing")?.description).toBe(
      description,
    );

    const output = formatSkillsList(report, {});
    const row = stripAnsi(output)
      .split("\n")
      .find((line) => line.includes("tab-spacing"));
    // The cell keeps the tab spacing the terminal rendered but never the C1 introducer.
    expect(row?.split(/[|│]/u)[3]?.trim()).toBe("left right");
    expect(output).not.toContain("\x9b");
  });

  it("strips terminal control sequences from table descriptions and sources", async () => {
    const description = "Evil \u001b[31mRED\u001b[0m\u0007 tail";
    const workspaceDir = tempDirs.make("esc-description-");
    await writeWorkspaceSkills(workspaceDir, [
      { name: "escape-demo", description: JSON.stringify(description) },
    ]);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, "managed"),
      config: { plugins: { enabled: false } },
    });
    expect(report.skills.find((skill) => skill.name === "escape-demo")?.description).toBe(
      description,
    );

    const output = formatSkillsList(report, {});
    const row = output.split("\n").find((line) => line.includes("escape-demo"));
    expect(row?.split(/[|│]/u)[3]?.trim()).toBe("Evil RED tail");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
  });

  it("preserves description and path whitespace in skills JSON output", async () => {
    const workspaceDir = tempDirs.make("json-whitespace-");
    const managedSkillsDir = path.join(workspaceDir, "managed\tlocal");
    const description = "First paragraph.\nSecond\tcolumn.\r\nThird paragraph.";
    await writeWorkspaceSkills(workspaceDir, [
      { name: "json-whitespace", description: JSON.stringify(description) },
    ]);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir,
      config: { plugins: { enabled: false } },
    });
    expect(report.skills[0]?.description).toBe(description);

    const list = JSON.parse(formatSkillsList(report, { json: true }));
    const info = JSON.parse(formatSkillInfo(report, "json-whitespace", { json: true }));
    const check = JSON.parse(formatSkillsCheck(report, { json: true }));
    expect(list.skills[0].description).toBe(description);
    expect(info.description).toBe(description);
    expect(list.managedSkillsDir).toBe(managedSkillsDir);
    expect(check.managedSkillsDir).toBe(managedSkillsDir);
  });
});
