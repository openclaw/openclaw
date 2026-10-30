// ClawHub release policy tests execute the real npm and ClawHub release checks.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../../helpers/temp-dir.js";
import { writeJsonFile } from "../../../helpers/temp-repo.js";

const CLAWHUB_CHECK = resolve("scripts/plugin-clawhub-release-check.ts");
const NPM_CHECK = resolve("scripts/plugin-npm-release-check.ts");
const REPOSITORY_URL = "https://github.com/openclaw/openclaw";
const PACKAGE_NAME = "@openclaw/demo-plugin";
const INITIAL_VERSION = "2026.8.3";
const tsxImport = import.meta.resolve("tsx");
const tempDirs: string[] = [];

type FixtureOptions = {
  includeBuildVersion?: boolean;
  includePluginApi?: boolean;
  repositoryUrl?: string;
  version?: string;
};

afterEach(() => cleanupTempDirs(tempDirs));

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function packageManifest(options: FixtureOptions = {}) {
  const version = options.version ?? INITIAL_VERSION;
  return {
    name: PACKAGE_NAME,
    version,
    type: "module",
    repository: { type: "git", url: options.repositoryUrl ?? REPOSITORY_URL },
    openclaw: {
      extensions: ["./index.ts"],
      ...(options.includePluginApi === false ? {} : { compat: { pluginApi: `>=${version}` } }),
      ...(options.includeBuildVersion === false ? {} : { build: { openclawVersion: version } }),
      install: { npmSpec: PACKAGE_NAME },
      release: { publishToClawHub: true, publishToNpm: true },
    },
  };
}

function createPluginRepo(options: FixtureOptions = {}) {
  const repoDir = makeTempRepoRoot(tempDirs, "openclaw-clawhub-policy-");
  const packageDir = join(repoDir, "extensions", "demo-plugin");
  mkdirSync(packageDir, { recursive: true });
  writeJsonFile(join(repoDir, "package.json"), {
    name: "openclaw-release-policy-fixture",
    private: true,
  });
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeJsonFile(join(packageDir, "package.json"), packageManifest(options));
  writeFileSync(join(packageDir, "index.ts"), "export const demo = 1;\n", "utf8");
  writeFileSync(join(packageDir, "README.md"), "# Demo plugin\n", "utf8");

  git(repoDir, ["init", "-b", "main"]);
  commitFixture(repoDir, "initial plugin");
  return repoDir;
}

function commitFixture(repoDir: string, message: string) {
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function runCheck(scriptPath: string, cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, ["--import", tsxImport, scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function expectValidChecks(repoDir: string, version: string, args: string[] = []) {
  for (const script of [CLAWHUB_CHECK, NPM_CHECK]) {
    const result = runCheck(script, repoDir, args);
    const command =
      script === CLAWHUB_CHECK ? "plugin-clawhub-release-check" : "plugin-npm-release-check";
    expect(result, result.stderr).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain(`${command}: publishable plugin metadata looks OK.`);
    expect(result.stdout).toContain(`- ${PACKAGE_NAME}@${version} (stable, demo-plugin)`);
  }
}

function expectInvalidChecks(repoDir: string, messages: string[]) {
  for (const script of [CLAWHUB_CHECK, NPM_CHECK]) {
    const result = runCheck(script, repoDir);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    for (const message of messages) {
      expect(result.stderr).toContain(message);
    }
  }
}

function commitSourceChange(repoDir: string) {
  writeFileSync(
    join(repoDir, "extensions/demo-plugin/index.ts"),
    "export const demo = 2;\n",
    "utf8",
  );
  return commitFixture(repoDir, "change plugin source");
}

it("validates package identity, version, and extension metadata through both release checks", () => {
  expectValidChecks(createPluginRepo(), INITIAL_VERSION);
});

it("requires the canonical repository provenance for ClawHub and npm publishing", () => {
  const repoDir = createPluginRepo({
    repositoryUrl: "https://example.invalid/not-openclaw",
  });
  expectInvalidChecks(repoDir, [
    `package.json repository.url must be "${REPOSITORY_URL}" so npm provenance can validate GitHub trusted publishing`,
  ]);
});

it("requires the external code plugin compatibility and build contract", () => {
  const repoDir = createPluginRepo({
    includeBuildVersion: false,
    includePluginApi: false,
  });

  expectInvalidChecks(repoDir, [
    "openclaw.compat.pluginApi is required for external code plugin packages.",
    "openclaw.build.openclawVersion is required for external code plugin packages.",
  ]);
});

it("rejects a changed publishable plugin whose committed version did not change", () => {
  const repoDir = createPluginRepo();
  const baseRef = git(repoDir, ["rev-parse", "HEAD"]);
  const headRef = commitSourceChange(repoDir);

  const result = runCheck(CLAWHUB_CHECK, repoDir, ["--base-ref", baseRef, "--head-ref", headRef]);

  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr).toContain("version bumps required before ClawHub publish");
  expect(result.stderr).toContain(
    `${PACKAGE_NAME}@${INITIAL_VERSION}: changed publishable plugin still has the same version in package.json.`,
  );
});

it("accepts a source change with a committed package version bump", () => {
  const repoDir = createPluginRepo();
  const baseRef = git(repoDir, ["rev-parse", "HEAD"]);
  const nextVersion = "2026.8.4";
  writeJsonFile(
    join(repoDir, "extensions/demo-plugin/package.json"),
    packageManifest({ version: nextVersion }),
  );
  const headRef = commitSourceChange(repoDir);
  const args = ["--base-ref", baseRef, "--head-ref", headRef];

  expectValidChecks(repoDir, nextVersion, args);
});
