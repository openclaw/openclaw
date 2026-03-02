import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-team-id.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BASE_PATH = process.env.PATH ?? "/usr/bin:/bin";
const BASE_LANG = process.env.LANG ?? "C";
let fixtureRoot = "";
let sharedBinDir = "";
let caseId = 0;

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
}

function runScript(
  homeDir: string,
  extraEnv: Record<string, string> = {},
): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const binDir = path.join(homeDir, "bin");
  const env = {
    HOME: homeDir,
    PATH: `${binDir}:${sharedBinDir}:${BASE_PATH}`,
    LANG: BASE_LANG,
    ...extraEnv,
  };
  try {
    const stdout = execFileSync(BASH_BIN, [SCRIPT], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const e = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? "");
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    return { ok: false, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

describe("scripts/ios-team-id.sh", () => {
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-ios-team-id-"));
    sharedBinDir = path.join(fixtureRoot, "shared-bin");
    await mkdir(sharedBinDir, { recursive: true });
    await writeExecutable(
      path.join(sharedBinDir, "plutil"),
      `#!/usr/bin/env bash
echo '{}'`,
    );
    await writeExecutable(
      path.join(sharedBinDir, "defaults"),
      `#!/usr/bin/env bash
if [[ "$3" == "DVTDeveloperAccountManagerAppleIDLists" ]]; then
  echo '(identifier = "dev@example.com";)'
  exit 0
fi
exit 0`,
    );
    await writeExecutable(
      path.join(sharedBinDir, "security"),
      `#!/usr/bin/env bash
if [[ "$1" == "cms" && "$2" == "-D" ]]; then
  if [[ "$4" == *"one.mobileprovision" ]]; then
    cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>TeamIdentifier</key><array><string>AAAAA11111</string></array></dict></plist>
PLIST
    exit 0
  fi
  if [[ "$4" == *"two.mobileprovision" ]]; then
    cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>TeamIdentifier</key><array><string>BBBBB22222</string></array></dict></plist>
PLIST
    exit 0
  fi
fi
exit 1`,
    );
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  async function createHomeDir(): Promise<{ homeDir: string; binDir: string }> {
    const homeDir = path.join(fixtureRoot, `case-${caseId++}`);
    await mkdir(homeDir, { recursive: true });
    const binDir = path.join(homeDir, "bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(path.join(homeDir, "Library", "Preferences"), { recursive: true });
    await writeFile(path.join(homeDir, "Library", "Preferences", "com.apple.dt.Xcode.plist"), "");
    return { homeDir, binDir };
  }

  it("resolves fallback and preferred team IDs from provisioning profiles", async () => {
    const { homeDir, binDir } = await createHomeDir();
    const profilesDir = path.join(homeDir, "Library", "MobileDevice", "Provisioning Profiles");
    await mkdir(profilesDir, { recursive: true });
    await writeFile(path.join(profilesDir, "one.mobileprovision"), "stub1");

    const fallbackResult = runScript(homeDir);
    expect(fallbackResult.ok).toBe(true);
    expect(fallbackResult.stdout).toBe("AAAAA11111");

    await writeFile(path.join(profilesDir, "two.mobileprovision"), "stub2");
    await writeExecutable(
      path.join(binDir, "fake-python"),
      `#!/usr/bin/env bash
printf 'AAAAA11111\\t0\\tAlpha Team\\r\\n'
printf 'BBBBB22222\\t0\\tBeta Team\\r\\n'`,
    );

    const crlfResult = runScript(homeDir, {
      IOS_PYTHON_BIN: path.join(binDir, "fake-python"),
      IOS_PREFERRED_TEAM_ID: "BBBBB22222",
    });
    expect(crlfResult.ok).toBe(true);
    expect(crlfResult.stdout).toBe("BBBBB22222");
  });

  it("prints actionable guidance when Xcode account exists but no Team ID is resolvable", async () => {
    const { homeDir, binDir } = await createHomeDir();
    await writeExecutable(
      path.join(binDir, "defaults"),
      `#!/usr/bin/env bash
if [[ "$3" == "DVTDeveloperAccountManagerAppleIDLists" ]]; then
  echo '(identifier = "dev@example.com";)'
  exit 0
fi
echo "Domain/default pair of (com.apple.dt.Xcode, $3) does not exist" >&2
exit 1`,
    );
    await writeExecutable(
      path.join(binDir, "security"),
      `#!/usr/bin/env bash
exit 1`,
    );

    const result = runScript(homeDir);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("An Apple account is signed in to Xcode");
    expect(result.stderr).toContain("IOS_DEVELOPMENT_TEAM");
  });
});
