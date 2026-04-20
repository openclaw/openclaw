import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const commonScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "common.sh");

function evaluateChangelogRequired(files: string[]) {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PR_COMMON_SH"
if changelog_required_for_changed_files "$OPENCLAW_TEST_FILES"; then
  printf true
else
  printf false
fi
`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PR_COMMON_SH: commonScriptPath,
        OPENCLAW_TEST_FILES: files.join("\n"),
      },
    },
  ).trim();

  return output === "true";
}

describe("scripts/pr-lib/common.sh", () => {
  it("does not require changelog entries for qa-only maintenance paths", () => {
    expect(
      evaluateChangelogRequired([
        "extensions/qa-channel/src/bus-client.ts",
        "extensions/qa-lab/src/bus-server.ts",
      ]),
    ).toBe(false);
  });

  it("does not require changelog entries for maintainer workflow paths", () => {
    expect(evaluateChangelogRequired(["scripts/pr-lib/common.sh", "docs/subagent.md"])).toBe(false);
  });

  it("still requires changelog entries when qa-only paths are mixed with product code", () => {
    expect(
      evaluateChangelogRequired([
        "extensions/qa-channel/src/bus-client.ts",
        "src/gateway/server.ts",
      ]),
    ).toBe(true);
  });
});
