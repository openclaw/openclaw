import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-team-id.sh");
const XCODE_PLIST_PATH = path.join("Library", "Preferences", "com.apple.dt.Xcode.plist");

const DEFAULTS_WITH_ACCOUNT_SCRIPT = `#!/usr/bin/env bash
if [[ "$3" == "DVTDeveloperAccountManagerAppleIDLists" ]]; then
  echo '(identifier = "dev@example.com";)'
  exit 0
fi
exit 0`;

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
}

async function setupFixture(params?: {
  provisioningProfiles?: Record<string, string>;
}): Promise<{ homeDir: string; binDir: string }> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-ios-team-id-"));
  const binDir = path.join(homeDir, "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(homeDir, "Library", "Preferences"), { recursive: true });
  await writeFile(path.join(homeDir, XCODE_PLIST_PATH), "");

  const provisioningProfiles = params?.provisioningProfiles;
  if (provisioningProfiles) {
    const profilesDir = path.join(homeDir, "Library", "MobileDevice", "Provisioning Profiles");
    await mkdir(profilesDir, { recursive: true });
    for (const [name, body] of Object.entries(provisioningProfiles)) {
      await writeFile(path.join(profilesDir, name), body);
    }
  }

  return { homeDir, binDir };
}

async function writeDefaultsWithSignedInAccount(binDir: string): Promise<void> {
  await writeExecutable(path.join(binDir, "defaults"), DEFAULTS_WITH_ACCOUNT_SCRIPT);
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
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    ...extraEnv,
  };
  try {
    const stdout = execFileSync("bash", [SCRIPT], {
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
  it("falls back to Xcode-managed provisioning profiles when preference teams are empty", async () => {
    const { homeDir, binDir } = await setupFixture({
      provisioningProfiles: {
        "one.mobileprovision": "stub",
      },
    });

    await writeExecutable(
      path.join(binDir, "plutil"),
      `#!/usr/bin/env bash
echo '{}'`,
    );
    await writeDefaultsWithSignedInAccount(binDir);
    await writeExecutable(
      path.join(binDir, "security"),
      `#!/usr/bin/env bash
if [[ "$1" == "cms" && "$2" == "-D" ]]; then
  cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>TeamIdentifier</key>
  <array>
    <string>ABCDE12345</string>
  </array>
</dict>
</plist>
PLIST
  exit 0
fi
exit 0`,
    );

    const result = runScript(homeDir);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("ABCDE12345");
  });

  it("prints actionable guidance when Xcode account exists but no Team ID is resolvable", async () => {
    const { homeDir, binDir } = await setupFixture();

    await writeExecutable(
      path.join(binDir, "plutil"),
      `#!/usr/bin/env bash
echo '{}'`,
    );
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

  it("honors IOS_PREFERRED_TEAM_ID when multiple profile teams are available", async () => {
    const { homeDir, binDir } = await setupFixture({
      provisioningProfiles: {
        "one.mobileprovision": "stub1",
        "two.mobileprovision": "stub2",
      },
    });

    await writeExecutable(
      path.join(binDir, "plutil"),
      `#!/usr/bin/env bash
echo '{}'`,
    );
    await writeDefaultsWithSignedInAccount(binDir);
    await writeExecutable(
      path.join(binDir, "security"),
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
  cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>TeamIdentifier</key><array><string>BBBBB22222</string></array></dict></plist>
PLIST
  exit 0
fi
exit 0`,
    );

    const result = runScript(homeDir, { IOS_PREFERRED_TEAM_ID: "BBBBB22222" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("BBBBB22222");
  });

  it("matches preferred team IDs even when parser output uses CRLF line endings", async () => {
    const { homeDir, binDir } = await setupFixture();

    await writeExecutable(
      path.join(binDir, "plutil"),
      `#!/usr/bin/env bash
echo '{}'`,
    );
    await writeDefaultsWithSignedInAccount(binDir);
    await writeExecutable(
      path.join(binDir, "fake-python"),
      `#!/usr/bin/env bash
printf 'AAAAA11111\\t0\\tAlpha Team\\r\\n'
printf 'BBBBB22222\\t0\\tBeta Team\\r\\n'`,
    );

    const result = runScript(homeDir, {
      IOS_PYTHON_BIN: path.join(binDir, "fake-python"),
      IOS_PREFERRED_TEAM_ID: "BBBBB22222",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("BBBBB22222");
  });
});
