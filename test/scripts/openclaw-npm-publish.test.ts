// OpenClaw NPM Publish tests cover publish wrapper argument safety.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const scriptPath = "scripts/openclaw-npm-publish.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runPublishWrapper(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "false", WORKFLOW_SHA: "", ...env },
  });
}

function makePackageTarball(root: string, packageJson?: string): string {
  const packageDir = path.join(root, "package");
  const tarball = path.join(root, "openclaw.tgz");
  mkdirSync(packageDir);
  if (packageJson === undefined) {
    writeFileSync(path.join(packageDir, "README.md"), "missing package metadata", "utf8");
  } else {
    writeFileSync(path.join(packageDir, "package.json"), packageJson, "utf8");
  }
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  return tarball;
}

describe("openclaw npm publish wrapper", () => {
  it("rejects missing publish mode before resolving release metadata", () => {
    const result = runPublishWrapper([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "usage: bash scripts/openclaw-npm-publish.sh --publish [package.tgz]",
    );
  });

  it("rejects option-like publish targets before npm publish", () => {
    const result = runPublishWrapper(["--publish", "--tag"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: unexpected npm publish target option: --tag");
  });

  it("rejects extra publish arguments before npm publish", () => {
    const tempRoot = tempDirs.make("openclaw-npm-publish-");
    const tarball = path.join(tempRoot, "openclaw.tgz");
    writeFileSync(tarball, "placeholder", "utf8");

    const result = runPublishWrapper(["--publish", tarball, "extra"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: unexpected npm publish argument: extra");
  });

  it("rejects a tarball whose package version differs from the checkout", () => {
    const tempRoot = tempDirs.make("openclaw-npm-publish-");
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    const tarballVersion = `${packageVersion}-mismatch`;
    const tarball = makePackageTarball(tempRoot, JSON.stringify({ version: tarballVersion }));
    const result = runPublishWrapper(["--publish", tarball], {
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `npm publish tarball version mismatch: expected ${packageVersion}, got ${tarballVersion}`,
    );
  });

  it.each([
    ["missing package.json", undefined, "missing a readable package/package.json"],
    ["malformed package.json", "{not-json", "package/package.json is malformed"],
    ["missing version", JSON.stringify({ name: "openclaw" }), "has no valid version"],
  ])("rejects a tarball with %s", (_label, packageJson, expectedError) => {
    const tempRoot = tempDirs.make("openclaw-npm-publish-");
    const tarball = makePackageTarball(tempRoot, packageJson);
    const result = runPublishWrapper(["--publish", tarball], {
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(expectedError);
  });
});
