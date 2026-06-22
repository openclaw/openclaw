// Release wrapper script tests keep changed-target routing tied to scripts that load the wrappers.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const UNKNOWN_PACKAGE = "@openclaw/not-a-real-release-wrapper-test-package";

function runTsxScript(scriptPath: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("release wrapper scripts", () => {
  it("runs plugin release wrapper CLIs and rejects unknown explicit selections", () => {
    for (const scriptPath of [
      "scripts/plugin-npm-release-plan.ts",
      "scripts/plugin-npm-release-check.ts",
      "scripts/plugin-clawhub-release-plan.ts",
      "scripts/plugin-clawhub-release-check.ts",
    ]) {
      const result = runTsxScript(scriptPath, ["--plugins", UNKNOWN_PACKAGE]);

      expect(result.status, scriptPath).toBe(1);
      expect(result.stderr, scriptPath).toContain(
        `Unknown or non-publishable plugin package selection: ${UNKNOWN_PACKAGE}.`,
      );
      expect(result.stdout, scriptPath).toBe("");
    }
  });

  it("loads the OpenClaw ClawHub plan CLI and validates required arguments before planning", () => {
    const result = runTsxScript("scripts/openclaw-release-clawhub-plan.ts", [
      "--release-tag",
      "v2026.6.21-beta.1",
      "--release-publish-run-id",
      "123",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--release-publish-branch is required.");
    expect(result.stdout).toBe("");
  });

  it("loads the beta verifier CLI and validates required version input before remote checks", () => {
    const result = runTsxScript("scripts/release-verify-beta.ts", ["--skip-clawhub"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: pnpm release:verify-beta -- <version>");
    expect(result.stdout).toBe("");
  });
});
