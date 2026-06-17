// Android version test support provides shared fixtures for Android script tests.
import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];

export function installAndroidFixtureCleanup(): void {
  afterEach(() => {
    cleanupTempDirs(tempDirs);
  });
}

export function writeAndroidFixture(params: {
  version: string;
  versionCode: number;
  packageVersion?: string;
  versionProperties?: string;
  prefix?: string;
}): string {
  const rootDir = makeTempDir(tempDirs, params.prefix ?? "openclaw-android-version-");
  fs.mkdirSync(path.join(rootDir, "apps", "android", "Config"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({ version: params.packageVersion ?? "2026.6.2" }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "apps", "android", "version.json"),
    `${JSON.stringify({ version: params.version, versionCode: params.versionCode }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "apps", "android", "Config", "Version.properties"),
    params.versionProperties ?? "",
    "utf8",
  );
  return rootDir;
}
