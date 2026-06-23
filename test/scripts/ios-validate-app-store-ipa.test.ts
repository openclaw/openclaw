// iOS IPA validation tests cover the App Store upload gate without real signing assets.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-validate-app-store-ipa.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";

const tempDirs: string[] = [];

function bashArgs(scriptPath: string): string[] {
  return process.platform === "win32" ? [scriptPath] : ["--noprofile", "--norc", scriptPath];
}

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
}

function plistString(key: string, value: string): string {
  return `<key>${key}</key><string>${value}</string>`;
}

function plistArray(key: string, values: readonly string[]): string {
  return `<key>${key}</key><array>${values.map((value) => `<string>${value}</string>`).join("")}</array>`;
}

function plistDict(key: string, body: string): string {
  return `<key>${key}</key><dict>${body}</dict>`;
}

function plist(body: string): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><dict>${body}</dict></plist>`,
  ].join("\n");
}

function writeFakePlistBuddy(filePath: string): void {
  writeExecutable(
    filePath,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const commandIndex = process.argv.indexOf("-c");
if (commandIndex < 0) process.exit(2);
const command = process.argv[commandIndex + 1] || "";
const file = process.argv[commandIndex + 2];
const keyPath = command.replace(/^Print:/, "").split(":").filter(Boolean);
const xml = readFileSync(file, "utf8");
const tokens = [...xml.matchAll(/<key>([^<]*)<\\/key>|<string>([^<]*)<\\/string>|<array>|<\\/array>|<dict>|<\\/dict>/g)];
let i = 0;
function parseValue() {
  const token = tokens[i++];
  if (!token) return undefined;
  const text = token[0];
  if (token[2] !== undefined) return token[2];
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
} else {
  process.exit(1);
}
`,
  );
}

function writeValidFixture(
  root: string,
  options: { pushMode?: string; legacyKey?: boolean } = {},
): {
  ipaPath: string;
  plistBuddy: string;
  codesign: string;
  security: string;
} {
  const binDir = path.join(root, "bin");
  const payloadDir = path.join(root, "Payload");
  const appDir = path.join(payloadDir, "OpenClaw.app");
  const fixturesDir = path.join(root, "fixtures");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });

  const infoBody = [
    plistString("CFBundleIdentifier", "ai.openclawfoundation.app"),
    plistString("OpenClawPushMode", options.pushMode ?? "appStore"),
    plistString("OpenClawPushRelayBaseURL", ""),
    options.legacyKey ? plistString("OpenClawPushRelayProfile", "production") : "",
  ].join("");
  writeFileSync(path.join(appDir, "Info.plist"), plist(infoBody), "utf8");
  writeFileSync(path.join(appDir, "embedded.mobileprovision"), "fixture profile", "utf8");

  const entitlementsPath = path.join(fixturesDir, "entitlements.plist");
  writeFileSync(
    entitlementsPath,
    plist(
      [
        plistString("application-identifier", "FWJYW4S8P8.ai.openclawfoundation.app"),
        plistString("com.apple.developer.team-identifier", "FWJYW4S8P8"),
        plistString("aps-environment", "production"),
        plistString("com.apple.developer.devicecheck.appattest-environment", "production"),
        plistArray("com.apple.security.application-groups", [
          "group.ai.openclawfoundation.app.shared",
        ]),
      ].join(""),
    ),
    "utf8",
  );

  const profilePath = path.join(fixturesDir, "profile.plist");
  writeFileSync(
    profilePath,
    plist(
      [
        plistString("Name", "OpenClaw App Store ai.openclawfoundation.app"),
        plistArray("TeamIdentifier", ["FWJYW4S8P8"]),
        plistDict(
          "Entitlements",
          [
            plistString("application-identifier", "FWJYW4S8P8.ai.openclawfoundation.app"),
            plistString("aps-environment", "production"),
            plistArray("com.apple.developer.devicecheck.appattest-environment", ["production"]),
            plistArray("com.apple.security.application-groups", [
              "group.ai.openclawfoundation.app.shared",
            ]),
          ].join(""),
        ),
      ].join(""),
    ),
    "utf8",
  );

  const plistBuddy = path.join(binDir, "plistbuddy");
  writeFakePlistBuddy(plistBuddy);
  const codesign = path.join(binDir, "codesign");
  writeExecutable(
    codesign,
    `#!/usr/bin/env bash
set -euo pipefail
cat "${entitlementsPath}"
`,
  );
  const security = path.join(binDir, "security");
  writeExecutable(
    security,
    `#!/usr/bin/env bash
set -euo pipefail
cat "${profilePath}"
`,
  );

  const ipaPath = path.join(root, "OpenClaw.ipa");
  execFileSync("zip", ["-qry", ipaPath, "Payload"], { cwd: root });
  return { ipaPath, plistBuddy, codesign, security };
}

function runValidator(fixture: {
  ipaPath: string;
  plistBuddy: string;
  codesign: string;
  security: string;
}): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(BASH_BIN, [...bashArgs(SCRIPT), "--ipa", fixture.ipaPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        IOS_VALIDATE_PLIST_BUDDY_BIN: fixture.plistBuddy,
        IOS_VALIDATE_CODESIGN_BIN: fixture.codesign,
        IOS_VALIDATE_SECURITY_BIN: fixture.security,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf8") : String(e.stdout ?? "");
    const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : String(e.stderr ?? "");
    return { ok: false, stdout, stderr };
  }
}

describe("scripts/ios-validate-app-store-ipa.sh", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an App Store IPA with appStore mode and production entitlements", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-ipa-"));
    tempDirs.push(root);
    const fixture = writeValidFixture(root);

    const result = runValidator(fixture);

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("Validated iOS App Store IPA");
  });

  it("rejects an IPA that was exported with a non-App-Store push mode", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-ipa-"));
    tempDirs.push(root);
    const fixture = writeValidFixture(root, { pushMode: "localProduction" });

    const result = runValidator(fixture);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("push mode mismatch");
  });

  it("rejects legacy independently selectable production push keys", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-ios-ipa-"));
    tempDirs.push(root);
    const fixture = writeValidFixture(root, { legacyKey: true });

    const result = runValidator(fixture);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("legacy relay profile");
  });
});
