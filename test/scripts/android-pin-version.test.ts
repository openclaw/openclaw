import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { parseArgs, pinAndroidVersion } from "../../scripts/android-pin-version.ts";
import { resolveAndroidVersion } from "../../scripts/lib/android-version.ts";
import {
  installAndroidFixtureCleanup,
  writeAndroidFixture,
} from "./android-version.test-support.ts";

installAndroidFixtureCleanup();

it("parses explicit version codes strictly", () => {
  expect(parseArgs(["--version", "2026.6.5", "--version-code", "2026060502"])).toMatchObject({
    explicitVersion: "2026.6.5",
    explicitVersionCode: 2026060502,
    fromGateway: false,
  });
});

it("rejects invalid pin sources, version codes, and missing option values", () => {
  for (const args of [[], ["--from-gateway", "--version", "2026.6.5"]]) {
    expect(() => parseArgs(args)).toThrow(
      "Choose exactly one of --from-gateway or --version <YYYY.M.PATCH>",
    );
  }
  for (const value of ["2026060502abc", "2026060502.5", "2e9", "0"]) {
    expect(() => parseArgs(["--version", "2026.6.5", "--version-code", value])).toThrow(
      `Invalid value for --version-code: ${value}. Expected a positive integer.`,
    );
  }
  for (const flag of ["--version", "--version-code", "--root"]) {
    const prefix = flag === "--version" ? [] : ["--version", "2026.6.5"];
    expect(() => parseArgs([...prefix, flag, "--no-sync"])).toThrow(`Missing value for ${flag}.`);
  }
});

function pinCase(
  name: string,
  options: Partial<Parameters<typeof pinAndroidVersion>[0]> = {},
  packageVersion?: string,
  version = "2026.6.5",
  code = 2026060501,
) {
  return { name, options, packageVersion, version, code };
}
const increment = { explicitVersion: "2026.6.2", explicitVersionCode: 2026060202 };
const pinCases = [
  pinCase("explicit release with generated artifacts"),
  pinCase("Gateway release", { explicitVersion: null, fromGateway: true }, "2026.6.5-beta.3"),
  pinCase("explicit versionCode increment", increment, undefined, "2026.6.2", 2026060202),
  pinCase("release without syncing artifacts", { sync: false }),
];

it.each(pinCases)("pins $name", ({ options, packageVersion, version, code }) => {
  const sync = options.sync ?? true;
  const rootDir = writeAndroidFixture({
    version: "2026.6.2",
    versionCode: 2026060201,
    packageVersion,
    versionProperties: sync ? "" : "stale\n",
    prefix: "openclaw-android-pin-",
  });
  const result = pinAndroidVersion({
    ...parseArgs(["--version", "2026.6.5", "--root", rootDir]),
    sync,
    ...options,
  });
  expect(result).toMatchObject({
    previousVersion: "2026.6.2",
    previousVersionCode: 2026060201,
    nextVersion: version,
    nextVersionCode: code,
    packageVersion: packageVersion ?? null,
  });
  expect(resolveAndroidVersion(rootDir)).toMatchObject({
    canonicalVersion: version,
    versionCode: code,
  });
  const read = (file: string) => fs.readFileSync(path.join(rootDir, "apps/android", file), "utf8");
  expect(read("version.json")).toContain(`"versionCode": ${code}`);
  const properties = read("Config/Version.properties");
  expect(result.syncedPaths).toHaveLength(sync ? 1 : 0);
  if (sync) {
    expect(properties).toContain(`OPENCLAW_ANDROID_VERSION_NAME=${version}`);
  } else {
    expect(properties).toBe("stale\n");
  }
});
