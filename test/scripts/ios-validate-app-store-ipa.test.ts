// iOS IPA validation tests cover the App Store upload gate without real signing assets.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-validate-app-store-ipa.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILD_TIMESTAMP = "2026-07-10T12:34:56.000Z";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let toolsDir: string;

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
}

type PlistValue = string | boolean | readonly string[] | { [key: string]: PlistValue };
function plistValue(value: PlistValue): string {
  if (typeof value === "string") {
    return `<string>${value}</string>`;
  }
  if (typeof value === "boolean") {
    return `<${value ? "true" : "false"}/>`;
  }
  if (Array.isArray(value)) {
    return `<array>${value.map(plistValue).join("")}</array>`;
  }
  return `<dict>${Object.entries(value)
    .map(([key, entry]) => `<key>${key}</key>${plistValue(entry)}`)
    .join("")}</dict>`;
}

function plist(body: Record<string, PlistValue>): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">${plistValue(body)}</plist>`,
  ].join("\n");
}

const fakeTools = {
  plistbuddy: `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const commandIndex = process.argv.indexOf("-c");
if (commandIndex < 0) process.exit(2);
const command = process.argv[commandIndex + 1] || "";
const file = process.argv[commandIndex + 2];
const keyPath = command.replace(/^Print:/, "").split(":").filter(Boolean);
const xml = readFileSync(file, "utf8");
const tokens = [...xml.matchAll(/<key>([^<]*)<\\/key>|<string>([^<]*)<\\/string>|<true\\/>|<false\\/>|<array>|<\\/array>|<dict>|<\\/dict>/g)];
let i = 0;
function parseValue() {
  const token = tokens[i++];
  if (!token) return undefined;
  const text = token[0];
  if (token[2] !== undefined) return token[2];
  if (text === "<true/>") return true;
  if (text === "<false/>") return false;
  if (text === "<dict>") return parseDict();
  if (text === "<array>") {
    const values = [];
    while (i < tokens.length && tokens[i][0] !== "</array>") {
      const value = parseValue();
      if (value !== undefined) values.push(value);
    }
    i++;
    return values;
  }
  return undefined;
}
function parseDict() {
  const obj = {};
  while (i < tokens.length && tokens[i][0] !== "</dict>") {
    const key = tokens[i++][1];
    if (key === undefined) continue;
    obj[key] = parseValue();
  }
  i++;
  return obj;
}
while (i < tokens.length && tokens[i][0] !== "<dict>") i++;
const root = parseValue();
let current = root;
for (const key of keyPath) {
  if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
    process.exit(1);
  }
  current = current[key];
}
if (Array.isArray(current)) {
  console.log("Array {");
  for (const value of current) console.log("    " + value);
  console.log("}");
} else if (current && typeof current === "object") {
  console.log("Dict {");
  console.log("}");
} else if (typeof current === "string") {
  console.log(current);
} else if (typeof current === "boolean") {
  console.log(current ? "true" : "false");
} else {
  process.exit(1);
}
`,
  plutil: `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
if (process.argv[2] === "-convert" && process.argv[3] === "xml1") {
  process.stdout.write(readFileSync(process.argv[process.argv.length - 1], "utf8"));
  process.exit(0);
}
const extractIndex = process.argv.indexOf("-extract");
const expectIndex = process.argv.indexOf("-expect");
if (extractIndex < 0 || expectIndex < 0 || process.argv[expectIndex + 1] !== "string") process.exit(2);
const key = process.argv[extractIndex + 1];
const file = process.argv[process.argv.length - 1];
const xml = readFileSync(file, "utf8");
// Escapes are doubled for the template-literal -> emitted-file hop: the emitted script
// must contain \\] in the class and \\$& in the replacement, or keys with regex
// metacharacters interpolate unescaped into the RegExp below and stop emulating plutil.
const escapedKey = key.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
const match = xml.match(new RegExp("<key>" + escapedKey + "</key>\\\\s*<string>([^<]*)</string>"));
if (!match) process.exit(1);
process.stdout.write(match[1]);
`,
  unzip: `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");
const requireFromRepo = createRequire(path.join(process.cwd(), "package.json"));
const JSZip = requireFromRepo("jszip");

const args = process.argv.slice(2);
let ipaPath = "";
let outputDir = "";
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-d") {
    outputDir = args[++i] || "";
  } else if (!arg.startsWith("-")) {
    ipaPath = arg;
  }
}
if (!ipaPath || !outputDir) process.exit(2);

(async () => {
  const zip = await JSZip.loadAsync(readFileSync(ipaPath));
  for (const [entryPath, entry] of Object.entries(zip.files)) {
    const outputPath = path.join(outputDir, entryPath);
    if (entry.dir) {
      mkdirSync(outputPath, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, await entry.async("nodebuffer"));
  }
})().catch(() => process.exit(1));
`,
};

async function writeValidFixture(
  root: string,
  options: {
    buildCommit?: string;
    healthUpdateUsage?: string | null;
    displayName?: string;
    localizedDisplayName?: string;
  } = {},
) {
  const binDir = path.join(root, "bin");
  const fixturesDir = path.join(root, "fixtures");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });
  const zip = new JSZip();
  const appFile = (name: string, body: string) =>
    zip.file(`Payload/OpenClaw.app/${name}`, body, { date: new Date(0) });
  const writeSigningFixture = (name: string, body: Record<string, PlistValue>) => {
    const file = path.join(fixturesDir, `${name}.plist`);
    writeFileSync(file, plist(body), "utf8");
    const executable = path.join(binDir, name);
    writeExecutable(
      executable,
      `#!/usr/bin/env bash
set -euo pipefail
cat "${file}"
`,
    );
    return executable;
  };

  const healthUsage = "OpenClaw reads Health data for Health Summaries.";
  const infoBody = {
    CFBundleIdentifier: "ai.openclawfoundation.app",
    CFBundleDisplayName: options.displayName ?? "OpenClaw",
    OpenClawGitCommit: options.buildCommit ?? BUILD_COMMIT,
    OpenClawBuildTimestamp: BUILD_TIMESTAMP,
    OpenClawPushMode: "appStore",
    OpenClawPushRelayBaseURL: "",
    NSHealthShareUsageDescription: healthUsage,
    ...(options.healthUpdateUsage === null
      ? {}
      : {
          NSHealthUpdateUsageDescription: options.healthUpdateUsage ?? healthUsage,
        }),
  };
  appFile("Info.plist", plist(infoBody));
  appFile(
    "de.lproj/InfoPlist.strings",
    plist(
      options.localizedDisplayName === undefined
        ? { NSCameraUsageDescription: "OpenClaw verwendet die Kamera." }
        : { CFBundleDisplayName: options.localizedDisplayName },
    ),
  );
  appFile("embedded.mobileprovision", "fixture profile");

  const sharedEntitlements = {
    "application-identifier": "FWJYW4S8P8.ai.openclawfoundation.app",
    "aps-environment": "production",
    "com.apple.developer.healthkit": true,
    "com.apple.security.application-groups": ["group.ai.openclawfoundation.app.shared"],
  };
  const codesign = writeSigningFixture("codesign", {
    ...sharedEntitlements,
    "com.apple.developer.team-identifier": "FWJYW4S8P8",
    "com.apple.developer.devicecheck.appattest-environment": "production",
  });
  const security = writeSigningFixture("security", {
    Name: "OpenClaw App Store ai.openclawfoundation.app",
    TeamIdentifier: ["FWJYW4S8P8"],
    Entitlements: {
      ...sharedEntitlements,
      "com.apple.developer.devicecheck.appattest-environment": ["production"],
    },
  });

  const plistBuddy = path.join(toolsDir, "plistbuddy");
  const plutil = path.join(toolsDir, "plutil");
  const unzip = path.join(toolsDir, "unzip");
  const ipaPath = path.join(root, "OpenClaw.ipa");
  writeFileSync(ipaPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return { ipaPath, plistBuddy, plutil, codesign, security, unzip };
}

function runValidator(
  fixture: Awaited<ReturnType<typeof writeValidFixture>>,
  expected: { commit?: string; timestamp?: string } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(
    BASH_BIN,
    [
      ...(process.platform === "win32" ? [SCRIPT] : ["--noprofile", "--norc", SCRIPT]),
      "--ipa",
      fixture.ipaPath,
      "--expected-commit",
      expected.commit ?? BUILD_COMMIT,
      "--expected-build-timestamp",
      expected.timestamp ?? BUILD_TIMESTAMP,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        IOS_VALIDATE_PLIST_BUDDY_BIN: fixture.plistBuddy,
        IOS_VALIDATE_PLUTIL_BIN: fixture.plutil,
        IOS_VALIDATE_CODESIGN_BIN: fixture.codesign,
        IOS_VALIDATE_SECURITY_BIN: fixture.security,
        IOS_VALIDATE_UNZIP_BIN: fixture.unzip,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const makeRoot = () => tempDirs.make("openclaw-ios-ipa-");

async function expectRejected(
  options: Parameters<typeof writeValidFixture>[1],
  message: string,
  expected?: Parameters<typeof runValidator>[1],
) {
  const result = runValidator(await writeValidFixture(makeRoot(), options), expected);
  expect(result).toMatchObject({ ok: false, stderr: expect.stringContaining(message) });
}

describe("scripts/ios-validate-app-store-ipa.sh", () => {
  beforeAll(() => {
    // Interpreters read fixture paths from argv; signing inputs remain case-owned.
    toolsDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-ipa-tools-"));
    for (const [name, body] of Object.entries(fakeTools)) {
      writeExecutable(path.join(toolsDir, name), body);
    }
  });

  afterAll(() => {
    if (toolsDir) {
      rmSync(toolsDir, { recursive: true, force: true });
    }
  });

  it("fake plutil escapes regex-metacharacter keys before matching", () => {
    const plutil = path.join(toolsDir, "plutil");
    const plistPath = path.join(makeRoot(), "meta.plist");
    writeFileSync(
      plistPath,
      "<plist><dict>\n<key>Weird[Key]*</key>\n<string>metavalue</string>\n</dict></plist>",
      "utf8",
    );
    const extract = (key: string) =>
      spawnSync(process.execPath, [plutil, "-extract", key, "-expect", "string", plistPath], {
        encoding: "utf8",
      });
    const escaped = extract("Weird[Key]*");
    expect(escaped).toMatchObject({ status: 0, stdout: "metavalue" });
    // An unescaped interpolation would let this key match as a regex; it must miss instead.
    const missing = extract("Weird.Key.*");
    expect(missing.status).toBe(1);
  });

  it("rejects an IPA without the Health update purpose string required by App Store Connect", async () => {
    await expectRejected(
      { healthUpdateUsage: null },
      "Health update usage description must be a non-empty string",
    );
  });

  it("rejects an IPA with the wrong canonical display name", async () => {
    await expectRejected({ displayName: "OpenClaw Debug" }, "display name mismatch");
  });

  it("rejects unresolved build settings in localized plist resources", async () => {
    await expectRejected(
      { localizedDisplayName: "$(OPENCLAW_APP_DISPLAY_NAME)" },
      "unresolved build setting in localized plist",
    );
  });

  it("rejects malformed or mismatched embedded build provenance", async () => {
    await expectRejected({ buildCommit: "deadbeef" }, "full lowercase commit SHA");
    await expectRejected({}, "embedded Git commit mismatch", { commit: "a".repeat(40) });
  });
});
