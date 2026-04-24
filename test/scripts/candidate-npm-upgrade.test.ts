import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/ops/candidate-npm-upgrade.sh";
const PACKAGE_JSON_PATH = "package.json";

describe("candidate npm upgrade tooling", () => {
  it("defaults to the 2026.4.5 -> 2026.4.23 isolated upgrade lane", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('baseline="openclaw@2026.4.5"');
    expect(script).toContain('target="2026.4.23"');
    expect(script).toContain('expected="2026.4.23"');
    expect(script).toContain('"$candidate_bin" update --tag "$target" --json');
  });

  it("forces npm, state, and package roots under the temporary candidate root", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('candidate_root="$(mktemp -d');
    expect(script).toContain('candidate_prefix="$candidate_root/npm-prefix"');
    expect(script).toContain('candidate_home="$candidate_root/home"');
    expect(script).toContain('export npm_config_prefix="$candidate_prefix"');
    expect(script).toContain('export OPENCLAW_HOME="$candidate_home"');
    expect(script).toContain('case "$package_root" in');
    expect(script).toContain('"$candidate_root"/*) ;;');
  });

  it("records live package identity before and after without service mutation commands", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('live_version_before="$(openclaw --version');
    expect(script).toContain('live_version_after="$("$live_openclaw" --version');
    expect(script).toContain("unchanged: liveVersionBefore === liveVersionAfter");
    expect(script).not.toMatch(
      /systemctl\s+(?:--user\s+)?(?:restart|reload|stop|start|disable|enable)/,
    );
    expect(script).not.toContain("sudo ");
  });

  it("exposes a repo-owned npm script for the 4.23 candidate proof", () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));

    expect(packageJson.scripts["ops:candidate-upgrade:4.23"]).toBe(
      "bash scripts/ops/candidate-npm-upgrade.sh",
    );
  });
});
