// Codesign Mac App tests cover codesign mac app script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/codesign-mac-app.sh";

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function entitlementTemps(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("openclaw-entitlements"));
}

function runCodesign(args: string[], tempRoot: string) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: tempRoot,
    },
  });
}

function installFakeCodesign(binDir: string) {
  const fakeCodesign = path.join(binDir, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/usr/bin/env bash
set -euo pipefail

entitlements=""
identity=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --entitlements)
      shift
      entitlements="$1"
      ;;
    --sign)
      shift
      identity="$1"
      ;;
  esac
  target="$1"
  shift || true
done

if [ -z "$target" ]; then
  echo "missing codesign target" >&2
  exit 2
fi

if [ -n "$entitlements" ]; then
  count_file="$CODESIGN_CAPTURE_DIR/count"
  count=0
  if [ -f "$count_file" ]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" >"$count_file"
  copy="$CODESIGN_CAPTURE_DIR/entitlements-$count.plist"
  cp "$entitlements" "$copy"
  printf 'entitled\\t%s\\t%s\\t%s\\t%s\\n' "$target" "$entitlements" "$copy" "$identity" >>"$CODESIGN_LOG"
else
  printf 'plain\\t%s\\t%s\\n' "$target" "$identity" >>"$CODESIGN_LOG"
fi
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

function autoSelectEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  // Auto-selection only runs when the operator pinned nothing, and ad-hoc must stay off so a
  // failed selection surfaces as an error instead of being masked by the "-" fallback.
  delete env.SIGN_IDENTITY;
  delete env.ALLOW_ADHOC_SIGNING;
  delete env.DISABLE_LIBRARY_VALIDATION;
  return env;
}

function installFakeSecurity(binDir: string, listing: string) {
  const fakeSecurity = path.join(binDir, "security");
  writeFileSync(
    fakeSecurity,
    `#!/usr/bin/env bash
set -euo pipefail

cat <<'LISTING'
${listing}
LISTING
`,
  );
  chmodSync(fakeSecurity, 0o755);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("codesign-mac-app temp file hygiene", () => {
  it("does not generate unused entitlement plist files", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('ENT_TMP_APP="$ENT_TMP_DIR/app.plist"');
    expect(script).not.toContain("ENT_TMP_BASE");
    expect(script).not.toContain("ENT_TMP_RUNTIME");
    expect(script).not.toContain("base.plist");
    expect(script).not.toContain("runtime.plist");
  });

  it("does not allocate entitlement temp files for help output", () => {
    const tempRoot = makeTempDir("openclaw-codesign-help-");
    const result = runCodesign(["--help"], tempRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: scripts/codesign-mac-app.sh");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("does not allocate entitlement temp files before app validation", () => {
    const tempRoot = makeTempDir("openclaw-codesign-missing-");
    const missingApp = path.join(tempRoot, "Missing.app");
    const result = runCodesign([missingApp], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("App bundle not found");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects unknown options before app validation", () => {
    const tempRoot = makeTempDir("openclaw-codesign-unknown-");
    const result = runCodesign(["--wat"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unknown codesign option: --wat");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("rejects extra app bundle arguments before signing", () => {
    const tempRoot = makeTempDir("openclaw-codesign-extra-");
    const app = path.join(tempRoot, "Fake.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    const result = runCodesign([app, "extra"], tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("ERROR: Unexpected codesign argument: extra");
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("cleans entitlement temp files when signing fails", () => {
    const tempRoot = makeTempDir("openclaw-codesign-fail-");
    const app = path.join(tempRoot, "Fake.app");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ALLOW_ADHOC_SIGNING: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).not.toBe(0);
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });

  it("passes generated app entitlements to signing commands and cleans them", () => {
    const tempRoot = makeTempDir("openclaw-codesign-success-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const captureDir = path.join(tempRoot, "capture");
    const logPath = path.join(captureDir, "codesign.log");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    mkdirSync(captureDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "openclaw-mlx-tts"), "#!/bin/sh\n");
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installFakeCodesign(binDir);

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODESIGN_CAPTURE_DIR: captureDir,
        CODESIGN_LOG: logPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SIGN_IDENTITY: "-",
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Codesign complete for ${app}`);

    const signLines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(signLines).toHaveLength(3);
    expect(signLines[0]).toContain(`${path.join(app, "Contents", "MacOS", "openclaw-mlx-tts")}\t`);
    expect(signLines[1]).toContain(`${path.join(app, "Contents", "MacOS", "OpenClaw")}\t`);
    expect(signLines[2]).toContain(`${app}\t`);
    for (const line of signLines) {
      const columns = line.split("\t");
      const entitlementPath = columns[2];
      const copiedEntitlementsPath = columns[3];
      const entitlementSource = expectDefined(entitlementPath, "codesign entitlement source path");
      const copiedEntitlementSource = expectDefined(
        copiedEntitlementsPath,
        "copied codesign entitlement path",
      );
      const copiedEntitlements = readFileSync(copiedEntitlementSource, "utf8");
      expect(entitlementSource).toContain("openclaw-entitlements");
      expect(existsSync(entitlementSource)).toBe(false);
      expect(copiedEntitlements).toContain("com.apple.security.automation.apple-events");
      expect(copiedEntitlements).toContain("com.apple.security.device.camera");
    }
    expect(entitlementTemps(tempRoot)).toEqual([]);
  });
});

describe("codesign-mac-app identity selection", () => {
  it("falls back to the first valid identity when no Apple-class cert exists", () => {
    const tempRoot = makeTempDir("openclaw-codesign-fallback-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const captureDir = path.join(tempRoot, "capture");
    const logPath = path.join(captureDir, "codesign.log");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    mkdirSync(captureDir);
    writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
    installFakeCodesign(binDir);
    installFakeSecurity(
      binDir,
      [
        '  1) 1A2B3C4D5E6F70819293A4B5C6D7E8F901234567 "Contoso Internal Signing (Z9Q8W7E6R5)"',
        "     1 valid identities found",
      ].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: autoSelectEnv({
        CODESIGN_CAPTURE_DIR: captureDir,
        CODESIGN_LOG: logPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      }),
    });

    expect(result.stderr).not.toContain("No signing identity found");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Using signing identity: Contoso Internal Signing (Z9Q8W7E6R5)",
    );

    // The selected identity must reach `codesign --sign`, not merely be echoed.
    const signLines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(signLines.length).toBeGreaterThan(0);
    for (const line of signLines) {
      expect(line.split("\t").at(-1)).toBe("Contoso Internal Signing (Z9Q8W7E6R5)");
    }
  });

  it("prefers a Developer ID Application cert over lower-ranked identities", () => {
    const tempRoot = makeTempDir("openclaw-codesign-preferred-");
    const app = path.join(tempRoot, "Fake.app");
    const binDir = path.join(tempRoot, "bin");
    const captureDir = path.join(tempRoot, "capture");
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(binDir);
    mkdirSync(captureDir);
    installFakeCodesign(binDir);
    // Ranking must win over listing order, so the preferred cert is listed last.
    installFakeSecurity(
      binDir,
      [
        '  1) 1A2B3C4D5E6F70819293A4B5C6D7E8F901234567 "Contoso Internal Signing (Z9Q8W7E6R5)"',
        '  2) 2B3C4D5E6F70819293A4B5C6D7E8F9012345678A "Apple Development: Dev Person (T1E2A3M4I5)"',
        '  3) 3C4D5E6F70819293A4B5C6D7E8F9012345678A2B "Developer ID Application: Contoso (T1E2A3M4I5)"',
        "     3 valid identities found",
      ].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath, app], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: autoSelectEnv({
        CODESIGN_CAPTURE_DIR: captureDir,
        CODESIGN_LOG: path.join(captureDir, "codesign.log"),
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SKIP_TEAM_ID_CHECK: "1",
        TMPDIR: tempRoot,
      }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Using signing identity: Developer ID Application: Contoso (T1E2A3M4I5)",
    );
  });
});
