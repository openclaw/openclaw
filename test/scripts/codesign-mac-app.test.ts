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

# Opt-in argv capture: only cases asserting on signing flags set CODESIGN_ARGS_LOG,
# so the entitlement-focused cases keep their existing CODESIGN_LOG shape.
if [ -n "\${CODESIGN_ARGS_LOG:-}" ]; then
  printf '%s\\t' "$@" >>"$CODESIGN_ARGS_LOG"
  printf '\\n' >>"$CODESIGN_ARGS_LOG"
fi

entitlements=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --entitlements)
      shift
      entitlements="$1"
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
  printf 'entitled\\t%s\\t%s\\t%s\\n' "$target" "$entitlements" "$copy" >>"$CODESIGN_LOG"
else
  printf 'plain\\t%s\\n' "$target" >>"$CODESIGN_LOG"
fi
`,
  );
  chmodSync(fakeCodesign, 0o755);
}

// Two Developer ID certs share a common name here: that ambiguity is exactly why
// operators pin SIGN_IDENTITY to a cert SHA-1 hash, which codesign also accepts.
const DEVELOPER_ID_HASH = "63A99BFF1D40E5A75C8A32B84BE99D1DDA6A44E1";
const APPLE_DEVELOPMENT_HASH = "11AA22BB33CC44DD55EE66FF77008899AABBCCDD";
const DEVELOPER_ID_NAME = "Developer ID Application: Example Corp (ABCDE12345)";
const FIND_IDENTITY_LISTING = [
  `  1) 7BB27EA163FB4783A0EBEB579DC66FBBACE96453 "${DEVELOPER_ID_NAME}"`,
  `  2) ${DEVELOPER_ID_HASH} "${DEVELOPER_ID_NAME}"`,
  `  3) ${APPLE_DEVELOPMENT_HASH} "Apple Development: Dev Person (ZZZZZ99999)"`,
  "     3 valid identities found",
].join("\n");

function installFakeSecurity(binDir: string) {
  const fakeSecurity = path.join(binDir, "security");
  writeFileSync(
    fakeSecurity,
    `#!/usr/bin/env bash
set -euo pipefail

if [ -n "\${SECURITY_LOG:-}" ]; then
  printf '%s\\n' "$*" >>"$SECURITY_LOG"
fi

if [ "\${1:-}" = "find-identity" ]; then
  cat <<'LISTING'
${FIND_IDENTITY_LISTING}
LISTING
  exit 0
fi

echo "unexpected security invocation: $*" >&2
exit 1
`,
  );
  chmodSync(fakeSecurity, 0o755);
}

type TimestampScenario = {
  codesignArgs: string[][];
  securityCalls: string[];
  status: number | null;
};

function runTimestampScenario(options: {
  prefix: string;
  identity: string;
  timestampMode?: string;
}): TimestampScenario {
  const tempRoot = makeTempDir(options.prefix);
  const app = path.join(tempRoot, "Fake.app");
  const binDir = path.join(tempRoot, "bin");
  const captureDir = path.join(tempRoot, "capture");
  const argsLogPath = path.join(captureDir, "codesign-args.log");
  const securityLogPath = path.join(captureDir, "security.log");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(binDir);
  mkdirSync(captureDir);
  writeFileSync(path.join(app, "Contents", "MacOS", "OpenClaw"), "#!/bin/sh\n");
  installFakeCodesign(binDir);
  installFakeSecurity(binDir);

  const result = spawnSync("bash", [scriptPath, app], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CODESIGN_ARGS_LOG: argsLogPath,
      CODESIGN_CAPTURE_DIR: captureDir,
      CODESIGN_LOG: path.join(captureDir, "codesign.log"),
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SECURITY_LOG: securityLogPath,
      SIGN_IDENTITY: options.identity,
      SKIP_TEAM_ID_CHECK: "1",
      TMPDIR: tempRoot,
      ...(options.timestampMode === undefined ? {} : { CODESIGN_TIMESTAMP: options.timestampMode }),
    },
  });

  const readLines = (file: string): string[] =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

  return {
    codesignArgs: readLines(argsLogPath).map((line) => line.split("\t").filter(Boolean)),
    securityCalls: readLines(securityLogPath),
    status: result.status,
  };
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

describe("codesign-mac-app timestamp policy", () => {
  it("timestamps a Developer ID identity pinned by certificate hash", () => {
    const scenario = runTimestampScenario({
      prefix: "openclaw-codesign-ts-hash-",
      identity: DEVELOPER_ID_HASH,
    });

    expect(scenario.status).toBe(0);
    expect(scenario.codesignArgs.length).toBeGreaterThan(0);
    for (const args of scenario.codesignArgs) {
      expect(args).toContain("--timestamp");
      expect(args).not.toContain("--timestamp=none");
    }
  });

  it("timestamps a Developer ID identity named in full without consulting the keychain", () => {
    const scenario = runTimestampScenario({
      prefix: "openclaw-codesign-ts-name-",
      identity: DEVELOPER_ID_NAME,
    });

    expect(scenario.status).toBe(0);
    expect(scenario.codesignArgs.length).toBeGreaterThan(0);
    for (const args of scenario.codesignArgs) {
      expect(args).toContain("--timestamp");
    }
    expect(scenario.securityCalls).toEqual([]);
  });

  it("does not timestamp a non-Developer-ID identity pinned by certificate hash", () => {
    const scenario = runTimestampScenario({
      prefix: "openclaw-codesign-ts-devhash-",
      identity: APPLE_DEVELOPMENT_HASH,
    });

    expect(scenario.status).toBe(0);
    expect(scenario.codesignArgs.length).toBeGreaterThan(0);
    for (const args of scenario.codesignArgs) {
      expect(args).toContain("--timestamp=none");
    }
  });

  it("does not timestamp a certificate hash that matches no identity", () => {
    const scenario = runTimestampScenario({
      prefix: "openclaw-codesign-ts-unknown-",
      identity: "0123456789ABCDEF0123456789ABCDEF01234567",
    });

    expect(scenario.status).toBe(0);
    expect(scenario.codesignArgs.length).toBeGreaterThan(0);
    for (const args of scenario.codesignArgs) {
      expect(args).toContain("--timestamp=none");
    }
  });

  it("keeps ad-hoc signing untimestamped", () => {
    const scenario = runTimestampScenario({
      prefix: "openclaw-codesign-ts-adhoc-",
      identity: "-",
    });

    expect(scenario.status).toBe(0);
    expect(scenario.codesignArgs.length).toBeGreaterThan(0);
    for (const args of scenario.codesignArgs) {
      expect(args).toContain("--timestamp=none");
    }
  });

  it("honors an explicit CODESIGN_TIMESTAMP=off for a Developer ID hash", () => {
    const scenario = runTimestampScenario({
      prefix: "openclaw-codesign-ts-off-",
      identity: DEVELOPER_ID_HASH,
      timestampMode: "off",
    });

    expect(scenario.status).toBe(0);
    expect(scenario.codesignArgs.length).toBeGreaterThan(0);
    for (const args of scenario.codesignArgs) {
      expect(args).toContain("--timestamp=none");
    }
  });
});
