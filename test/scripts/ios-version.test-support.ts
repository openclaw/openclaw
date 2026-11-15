// iOS version test support provides shared fixtures for iOS script tests.
import { afterEach } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const tempDirs: string[] = [];

export function installIosFixtureCleanup(): void {
  afterEach(() => {
    cleanupTempDirs(tempDirs);
  });
}

export function writeIosFixture(params: {
  version?: string;
  changelog: string;
  packageVersion?: string;
  prefix?: string;
}): string {
  const rootDir = makeTempDir(tempDirs, params.prefix ?? "openclaw-ios-version-");
  const { write } = fixtureFiles(rootDir);
  write(
    "package.json",
    `${JSON.stringify({ version: params.packageVersion ?? params.version ?? "2026.4.6" }, null, 2)}\n`,
  );
  write("apps/ios/CHANGELOG.md", params.changelog);
  return rootDir;
}
