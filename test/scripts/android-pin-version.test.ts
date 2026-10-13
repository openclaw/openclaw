import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, pinAndroidVersion } from "../../scripts/android-pin-version.ts";
import { resolveAndroidVersion } from "../../scripts/lib/android-version.ts";
import {
  installAndroidFixtureCleanup,
  writeAndroidFixture,
} from "./android-version.test-support.ts";

installAndroidFixtureCleanup();

describe("parseArgs", () => {
  it("parses explicit version codes strictly", () => {
    expect(parseArgs(["--version", "2026.6.5", "--version-code", "2026060502"])).toMatchObject({
      explicitVersion: "2026.6.5",
      explicitVersionCode: 2026060502,
      fromGateway: false,
    });
  });

  it("rejects invalid pin sources, version codes, and missing option values", () => {
    const cases: { args: string[]; message: string }[] = [
      { args: [], message: "Choose exactly one of --from-gateway or --version <YYYY.M.PATCH>" },
      {
        args: ["--from-gateway", "--version", "2026.6.5"],
        message: "Choose exactly one of --from-gateway or --version <YYYY.M.PATCH>",
      },
      ...["2026060502abc", "2026060502.5", "2e9", "0"].map((value) => ({
        args: ["--version", "2026.6.5", "--version-code", value],
        message: `Invalid value for --version-code: ${value}. Expected a positive integer.`,
      })),
      { args: ["--version", "--no-sync"], message: "Missing value for --version." },
      {
        args: ["--version", "2026.6.5", "--version-code", "--no-sync"],
        message: "Missing value for --version-code.",
      },
      {
        args: ["--version", "2026.6.5", "--root", "--no-sync"],
        message: "Missing value for --root.",
      },
    ];
    for (const { args, message } of cases) {
      expect(() => parseArgs(args)).toThrow(message);
    }
  });
});

type PinCase = {
  name: string;
  options?: Partial<Parameters<typeof pinAndroidVersion>[0]>;
  packageVersion?: string;
  expectedVersion: string;
  expectedCode: number;
};
const pinCases: PinCase[] = [
  {
    name: "explicit release with generated artifacts",
    expectedVersion: "2026.6.5",
    expectedCode: 2026060501,
  },
  {
    name: "Gateway release without prerelease suffixes",
    options: { explicitVersion: null, fromGateway: true },
    packageVersion: "2026.6.5-beta.3",
    expectedVersion: "2026.6.5",
    expectedCode: 2026060501,
  },
  {
    name: "explicit versionCode increment on the same train",
    options: { explicitVersion: "2026.6.2", explicitVersionCode: 2026060202 },
    expectedVersion: "2026.6.2",
    expectedCode: 2026060202,
  },
  {
    name: "release without syncing checked-in artifacts",
    options: { sync: false },
    expectedVersion: "2026.6.5",
    expectedCode: 2026060501,
  },
];

it.each(pinCases)("pins $name", ({ options, packageVersion, expectedVersion, expectedCode }) => {
  const sync = options?.sync ?? true;
  const rootDir = writeAndroidFixture({
    version: "2026.6.2",
    versionCode: 2026060201,
    packageVersion,
    versionProperties: sync ? "" : "stale\n",
    prefix: "openclaw-android-pin-",
  });
  const result = pinAndroidVersion({
    explicitVersion: "2026.6.5",
    explicitVersionCode: null,
    fromGateway: false,
    rootDir,
    sync,
    ...options,
  });
  expect(result).toMatchObject({
    previousVersion: "2026.6.2",
    previousVersionCode: 2026060201,
    nextVersion: expectedVersion,
    nextVersionCode: expectedCode,
    packageVersion: packageVersion ?? null,
  });
  expect(resolveAndroidVersion(rootDir)).toMatchObject({
    canonicalVersion: expectedVersion,
    versionCode: expectedCode,
  });
  expect(fs.readFileSync(path.join(rootDir, "apps", "android", "version.json"), "utf8")).toContain(
    `"versionCode": ${expectedCode}`,
  );
  const properties = fs.readFileSync(
    path.join(rootDir, "apps", "android", "Config", "Version.properties"),
    "utf8",
  );
  if (sync) {
    expect(properties).toContain(`OPENCLAW_ANDROID_VERSION_NAME=${expectedVersion}`);
    expect(result.syncedPaths).toHaveLength(1);
  } else {
    expect(properties).toBe("stale\n");
    expect(result.syncedPaths).toHaveLength(0);
  }
});
