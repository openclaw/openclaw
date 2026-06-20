// QA UX Matrix evidence producer tests cover operator-facing CLI behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/qa/ux-matrix-evidence-producer.ts", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

describe("QA UX Matrix evidence producer CLI", () => {
  it("prints help without generating evidence", () => {
    const result = runCli("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/qa/ux-matrix-evidence-producer.ts",
    );
    expect(result.stderr).toBe("");
  });

  it("reports invalid args without a Node stack trace", () => {
    const result = runCli("--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unsupported UX Matrix producer arg: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("reports missing valued args without a Node stack trace", () => {
    const result = runCli("--artifact-base", "--repo-root", ".");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--artifact-base requires a value");
    expectNoNodeStack(result.stderr);
  });

  it("sanitizes local checkout paths from generated evidence artifacts", () => {
    const artifactBase = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ux-evidence-test-"));
    const fakeRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ux-repo-test-"));
    try {
      const result = runCli(
        "--artifact-base",
        artifactBase,
        "--repo-root",
        fakeRepoRoot,
        "--skip-visual-proof",
      );

      expect(result.status).toBe(0);
      const evidence = fs.readFileSync(path.join(artifactBase, "qa-evidence.json"), "utf8");
      const cliLog = fs.readFileSync(
        path.join(artifactBase, "surfaces", "cli", "stages", "entrypoint-help", "logs.txt"),
        "utf8",
      );
      expect(evidence).not.toContain(fakeRepoRoot);
      expect(cliLog).not.toContain(fakeRepoRoot);
      expect(`${evidence}\n${cliLog}`).toContain("<repo-root>");
    } finally {
      fs.rmSync(artifactBase, { recursive: true, force: true });
      fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
    }
  });
});
