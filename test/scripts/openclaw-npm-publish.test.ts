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

function makeStagedNpm(root: string): string {
  const callsPath = path.join(root, "npm-calls.jsonl");
  const npmPath = path.join(root, "npm");
  writeFileSync(
    npmPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "fs.appendFileSync(process.env.NPM_CALLS, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      'if (process.argv[2] === "publish") {',
      '  console.error("npm error code E409");',
      '  console.error("npm error Cannot publish over previously staged version");',
      "  process.exit(Number(process.env.NPM_PUBLISH_EXIT || 1));",
      "}",
      'if (process.env.NPM_VIEW_FAIL === "1") {',
      '  console.error("npm error code E404");',
      "  process.exit(1);",
      "}",
      'console.log(JSON.stringify({ version: process.env.PACKAGE_VERSION, "dist.integrity": "sha512-fixture" }));',
    ].join("\n"),
    { mode: 0o755 },
  );
  return callsPath;
}

function readNpmCalls(callsPath: string): string[][] {
  return readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
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
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({ name: "openclaw", version: tarballVersion }),
    );
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
    ["missing version", JSON.stringify({ name: "openclaw" }), "has no valid package identity"],
    ["missing name", JSON.stringify({ version: "2026.1.1" }), "has no valid package identity"],
  ])("rejects a tarball with %s", (_label, packageJson, expectedError) => {
    const tempRoot = tempDirs.make("openclaw-npm-publish-");
    const tarball = makePackageTarball(tempRoot, packageJson);
    const result = runPublishWrapper(["--publish", tarball], {
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(expectedError);
  });

  it.each([
    ["published", { NPM_PUBLISH_EXIT: "42" }, 42, "Exact-version registry observation: published"],
    [
      "not yet readable",
      { NPM_VIEW_FAIL: "1" },
      1,
      "Exact-version registry observation: staged or not yet publicly readable",
    ],
  ] as const)(
    "explains a staged npm version that is %s without republishing",
    (_label, env, status, observation) => {
      const tempRoot = tempDirs.make("openclaw-npm-publish-");
      const callsPath = makeStagedNpm(tempRoot);
      const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
      const result = runPublishWrapper(["--publish"], {
        NPM_CALLS: callsPath,
        OPENCLAW_NPM_PUBLISH_TAG: "beta",
        PACKAGE_VERSION: packageVersion,
        PATH: `${tempRoot}:${process.env.PATH}`,
        ...env,
      });

      expect(result.status).toBe(status);
      expect(result.stderr).toContain("Cannot publish over previously staged version");
      expect(result.stderr).toContain(`npm retained openclaw@${packageVersion}`);
      expect(result.stderr).toContain(observation);
      expect(result.stderr).toContain("Do not rerun npm publish");
      expect(result.stderr).toContain(
        `scripts/openclaw-npm-postpublish-verify.ts ${packageVersion}`,
      );
      expect(readNpmCalls(callsPath)).toEqual([
        ["publish", "--access", "public", "--tag", "beta", "--provenance"],
        [
          "view",
          `openclaw@${packageVersion}`,
          "version",
          "dist.integrity",
          "--json",
          "--prefer-online",
        ],
      ]);
    },
  );

  it("observes a staged companion tarball by its exact package identity", () => {
    const tempRoot = tempDirs.make("openclaw-npm-publish-");
    const callsPath = makeStagedNpm(tempRoot);
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
    const packageName = "@openclaw/gateway-client";
    const tarball = makePackageTarball(
      tempRoot,
      JSON.stringify({ name: packageName, version: packageVersion }),
    );
    const result = runPublishWrapper(["--publish", tarball], {
      NPM_CALLS: callsPath,
      OPENCLAW_NPM_PUBLISH_TAG: "beta",
      PACKAGE_VERSION: packageVersion,
      PATH: `${tempRoot}:${process.env.PATH}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `npm retained ${packageName}@${packageVersion} as staged or completed`,
    );
    expect(result.stderr).toContain(
      "Do not rerun npm publish or run the openclaw postpublish verifier",
    );
    expect(result.stderr).toContain("resume the original release workflow");
    expect(result.stderr).not.toContain("scripts/openclaw-npm-postpublish-verify.ts");
    expect(readNpmCalls(callsPath)).toEqual([
      ["publish", tarball, "--access", "public", "--tag", "beta", "--provenance"],
      [
        "view",
        `${packageName}@${packageVersion}`,
        "version",
        "dist.integrity",
        "--json",
        "--prefer-online",
      ],
    ]);
  });
});
