import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-team-id.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BASH_ARGS = process.platform === "win32" ? [SCRIPT] : ["--noprofile", "--norc", SCRIPT];
const BASE_PATH = process.env.PATH ?? "/usr/bin:/bin";
const BASE_LANG = process.env.LANG ?? "C";
let fixtureRoot = "";
let sharedBinDir = "";
let sharedHomeDir = "";
let sharedFakePythonPath = "";
const runScriptCache = new Map<string, { ok: boolean; stdout: string; stderr: string }>();
type TeamCandidate = {
  teamId: string;
  isFree: boolean;
  teamName: string;
};

function parseTeamCandidateRows(raw: string): TeamCandidate[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/\r/g, "").trim())
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 3)
    .map((parts) => ({
      teamId: parts[0] ?? "",
      isFree: (parts[1] ?? "0") === "1",
      teamName: parts[2] ?? "",
    }))
    .filter((candidate) => candidate.teamId.length > 0);
}

function pickTeamIdFromCandidates(params: {
  candidates: TeamCandidate[];
  preferredTeamId?: string;
  preferredTeamName?: string;
  preferNonFreeTeam?: boolean;
}): string | undefined {
  const preferredTeamId = (params.preferredTeamId ?? "").trim();
  if (preferredTeamId) {
    const preferred = params.candidates.find((candidate) => candidate.teamId === preferredTeamId);
    if (preferred) {
      return preferred.teamId;
    }
  }

  const preferredTeamName = (params.preferredTeamName ?? "").trim().toLowerCase();
  if (preferredTeamName) {
    const preferredByName = params.candidates.find(
      (candidate) => candidate.teamName.trim().toLowerCase() === preferredTeamName,
    );
    if (preferredByName) {
      return preferredByName.teamId;
    }
  }

  if (params.preferNonFreeTeam !== false) {
    const paid = params.candidates.find((candidate) => !candidate.isFree);
    if (paid) {
      return paid.teamId;
    }
  }

  return params.candidates[0]?.teamId;
}

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
  const extraEnvKey = Object.keys(extraEnv)
    .toSorted((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${extraEnv[key] ?? ""}`)
    .join("\u0001");
  const cacheKey = `${homeDir}\u0000${extraEnvKey}`;
  const cached = runScriptCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const binDir = path.join(homeDir, "bin");
  const env = {
    HOME: homeDir,
    PATH: `${binDir}:${sharedBinDir}:${BASE_PATH}`,
    LANG: BASE_LANG,
    ...extraEnv,
  };
  try {
    const stdout = execFileSync(BASH_BIN, BASH_ARGS, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = { ok: true, stdout: stdout.trim(), stderr: "" };
    runScriptCache.set(cacheKey, result);
    return result;
  } catch (error) {
    const e = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString("utf8") ?? "");
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    const result = { ok: false, stdout: stdout.trim(), stderr: stderr.trim() };
    runScriptCache.set(cacheKey, result);
    return result;
  }
}

describe("scripts/ios-team-id.sh", () => {
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "bot-ios-team-id-shared-"));
    sharedHomeDir = path.join(fixtureRoot, "home");
    sharedBinDir = path.join(fixtureRoot, "bin");
    sharedFakePythonPath = path.join(sharedBinDir, "fake-python3");
    await mkdir(sharedBinDir, { recursive: true });
    await mkdir(path.join(sharedHomeDir, "Library", "Preferences"), { recursive: true });
    await writeFile(
      path.join(sharedHomeDir, "Library", "Preferences", "com.apple.dt.Xcode.plist"),
      "",
    );
    await writeExecutable(path.join(sharedBinDir, "plutil"), `#!/usr/bin/env bash\necho '{}'`);
    await writeExecutable(
      path.join(sharedBinDir, "defaults"),
      `#!/usr/bin/env bash
if [[ "$3" == "DVTDeveloperAccountManagerAppleIDLists" ]]; then
  echo '(identifier = "dev@example.com";)'
  exit 0
fi
echo "Domain/default pair of (com.apple.dt.Xcode, $3) does not exist" >&2
exit 1`,
    );
  });

  it("falls back to Xcode-managed provisioning profiles when preference teams are empty", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "bot-ios-team-id-"));
    const binDir = path.join(homeDir, "bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(path.join(homeDir, "Library", "Preferences"), { recursive: true });
    const profilesDir = path.join(homeDir, "Library", "MobileDevice", "Provisioning Profiles");
    await mkdir(profilesDir, { recursive: true });
    await writeFile(path.join(profilesDir, "test.mobileprovision"), "stub");
    await writeFile(path.join(homeDir, "Library", "Preferences", "com.apple.dt.Xcode.plist"), "");
    await writeFile(
      path.join(sharedHomeDir, "Library", "Preferences", "com.apple.dt.Xcode.plist"),
      "",
    );
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
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "bot-ios-team-id-"));
    const binDir = path.join(homeDir, "bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(path.join(homeDir, "Library", "Preferences"), { recursive: true });
    await writeFile(path.join(homeDir, "Library", "Preferences", "com.apple.dt.Xcode.plist"), "");

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
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "bot-ios-team-id-"));
    const binDir = path.join(homeDir, "bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(path.join(homeDir, "Library", "Preferences"), { recursive: true });
    await mkdir(path.join(homeDir, "Library", "MobileDevice", "Provisioning Profiles"), {
      recursive: true,
    });
    await writeFile(path.join(homeDir, "Library", "Preferences", "com.apple.dt.Xcode.plist"), "");
    await writeFile(
      path.join(homeDir, "Library", "MobileDevice", "Provisioning Profiles", "one.mobileprovision"),
      "stub1",
    );
    await writeFile(
      path.join(homeDir, "Library", "MobileDevice", "Provisioning Profiles", "two.mobileprovision"),
      "stub2",
    );

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
exit 0`,
    );
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

    const result = runScript(homeDir, { IOS_PREFERRED_TEAM_ID: "BBBBB22222" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("BBBBB22222");
  });

  it("matches preferred team IDs even when parser output uses CRLF line endings", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "bot-ios-team-id-"));
    const binDir = path.join(homeDir, "bin");
    await mkdir(binDir, { recursive: true });
    await mkdir(path.join(homeDir, "Library", "Preferences"), { recursive: true });
    await writeFile(path.join(homeDir, "Library", "Preferences", "com.apple.dt.Xcode.plist"), "");

    await writeExecutable(
      sharedFakePythonPath,
      `#!/usr/bin/env bash
printf 'AAAAA11111\\t0\\tAlpha Team\\r\\n'
printf 'BBBBB22222\\t0\\tBeta Team\\r\\n'`,
    );
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("parses team listings and prioritizes preferred IDs without shelling out", () => {
    const rows = parseTeamCandidateRows(
      "AAAAA11111\t1\tAlpha Team\r\nBBBBB22222\t0\tBeta Team\r\n",
    );
    expect(rows).toStrictEqual([
      { teamId: "AAAAA11111", isFree: true, teamName: "Alpha Team" },
      { teamId: "BBBBB22222", isFree: false, teamName: "Beta Team" },
    ]);

    const preferred = pickTeamIdFromCandidates({
      candidates: rows,
      preferredTeamId: "BBBBB22222",
    });
    expect(preferred).toBe("BBBBB22222");

    const fallback = pickTeamIdFromCandidates({
      candidates: rows,
      preferredTeamId: "CCCCCC3333",
    });
    expect(fallback).toBe("BBBBB22222");
  });

  it("resolves a fallback team ID from Xcode team listings (smoke)", async () => {
    const fallbackResult = runScript(sharedHomeDir, { IOS_PYTHON_BIN: sharedFakePythonPath });
    expect(fallbackResult.ok).toBe(true);
    expect(fallbackResult.stdout).toBe("AAAAA11111");
  });

  it("prints actionable guidance when Xcode account exists but no Team ID is resolvable", async () => {
    const result = runScript(sharedHomeDir);
    expect(result.ok).toBe(false);
    expect(
      result.stderr.includes("An Apple account is signed in to Xcode") ||
        result.stderr.includes("No Apple Team ID found in Xcode accounts"),
    ).toBe(true);
    expect(
      result.stderr.includes("IOS_DEVELOPMENT_TEAM") ||
        result.stderr.includes("IOS_ALLOW_KEYCHAIN_TEAM_FALLBACK"),
    ).toBe(true);
  });
});
