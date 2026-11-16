import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const scriptPath = "scripts/plugin-npm-publish.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function publish(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function makePackage(version: string) {
  const root = tempDirs.make("openclaw-plugin-publish-test-");
  const packageDir = join(root, "plugin");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeJsonFile(join(packageDir, "package.json"), { name: "@openclaw/demo", version });
  const npmPath = join(binDir, "npm");
  writeFileSync(npmPath, "#!/bin/sh\nexit 1\n");
  chmodSync(npmPath, 0o755);
  return { packageDir, path: `${binDir}${delimiter}${process.env.PATH ?? ""}`, root };
}

it("revalidates release tooling after preparation and immediately before npm publish", () => {
  const source = readFileSync(scriptPath, "utf8");
  const buildIndex = source.indexOf("build_package_runtime");
  const identityIndex = source.indexOf("\n  verify_release_tooling_identity", buildIndex);
  const publishIndex = source.indexOf(
    'run_with_manifest_overlay "${publish_cmd[@]}"',
    identityIndex,
  );

  expect(buildIndex).toBeGreaterThan(-1);
  expect(identityIndex).toBeGreaterThan(buildIndex);
  expect(publishIndex).toBeGreaterThan(identityIndex);
  expect(source.slice(identityIndex, publishIndex)).not.toContain("npm view");
});

it.each<[string[], string]>([
  [
    [],
    "usage: bash scripts/plugin-npm-publish.sh [--repo-root <dir>] [--dry-run|--pack|--pack-dry-run|--publish] <package-dir>",
  ],
  [["--dry-run", "--wat"], "unexpected plugin npm package-dir option: --wat"],
  [["--dry-run", "extensions/telegram", "extra"], "unexpected plugin npm publish argument: extra"],
])("rejects arguments %j before package checks", (args, message) => {
  const result = publish(args);
  expect([result.status, result.stdout, result.stderr.trim()]).toEqual([2, "", message]);
});

it("runs trusted tooling against an explicit repository root", () => {
  const fixture = makePackage("2026.8.1-beta.1");
  const result = publish(["--repo-root", fixture.root, "--dry-run", "plugin"], {
    PATH: fixture.path,
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`Resolved repository root: ${fixture.root}`);
  expect(result.stdout).toContain(`Resolved package dir: ${fixture.packageDir}`);
  expect(result.stdout).toContain("Resolved package name: @openclaw/demo");
});

it("uses the extended-stable plan without latest or beta mirrors", () => {
  const fixture = makePackage("2026.7.33");
  const result = publish(["--dry-run", fixture.packageDir], {
    OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: "extended-stable",
    PATH: fixture.path,
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Resolved publish tag: extended-stable");
  expect(result.stdout).toContain("Resolved mirror dist-tags: <none>");
  expect(result.stdout).toContain("npm publish --access public --tag extended-stable");
});
