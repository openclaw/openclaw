import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { hasTerminalControl } from "../../packages/terminal-core/src/safe-text.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import { writeWorkspaceSkills } from "../skills/test-support/e2e-test-helpers.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const escape = "\u001b]0;untrusted-title\u0007\u009f";
const untrusted = (text: string) => `${text}${escape}`;
const config = { plugins: { enabled: false } };

describe("descriptor terminal rendering", () => {
  it("renders skill metadata safely without mutating discovery", async () => {
    const workspaceDir = tempDirs.make("skill-terminal-");
    await writeWorkspaceSkills(workspaceDir, [
      {
        name: "terminal-fixture",
        description: JSON.stringify(untrusted("Readable description")),
        metadata: JSON.stringify({
          openclaw: {
            emoji: untrusted("🧪"),
            primaryEnv: untrusted("MISSING_FIXTURE_ENV"),
            requires: { env: [untrusted("MISSING_FIXTURE_ENV")] },
            install: [{ kind: "brew", formula: "fixture", label: untrusted("Install fixture") }],
          },
        }),
      },
    ]);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, "managed"),
      config,
    });
    const entry = report.skills.find((skill) => skill.name === "terminal-fixture");
    expect(entry?.emoji).toBe(untrusted("🧪"));
    for (const output of [
      formatSkillsList(report, { verbose: true }),
      formatSkillInfo(report, "terminal-fixture", {}),
      formatSkillsCheck(report, {}),
    ]) {
      expect(
        hasTerminalControl(
          stripAnsi(output).replaceAll("\n", "").replaceAll("\r", "").replaceAll("\t", ""),
        ),
      ).toBe(false);
      expect(output).not.toContain(escape);
      expect(output).toContain("terminal-fixture");
    }
    const info = stripAnsi(formatSkillInfo(report, "terminal-fixture", {}));
    expect(info).toContain("🧪 terminal-fixture");
    expect(info).toContain("MISSING_FIXTURE_ENV");
    expect(info).toContain("Install fixture");
    expect(entry?.emoji).toBe(untrusted("🧪"));
  });
});
