import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-team-id.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BASH_ARGS = process.platform === "win32" ? [SCRIPT] : ["--noprofile", "--norc", SCRIPT];
const BASE_PATH = process.env.PATH ?? "/usr/bin:/bin";
const BASE_LANG = process.env.LANG ?? "C";
const CANONICAL_TEAM_ID = "FWJYW4S8P8";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const writeExecutable = (filePath: string, body: string) =>
  writeFileSync(filePath, `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });

function runScript(
  homeDir: string,
  extraEnv: Record<string, string> = {},
  scriptArgs: string[] = [],
) {
  const { status, stdout, stderr } = spawnSync(BASH_BIN, [...BASH_ARGS, ...scriptArgs], {
    env: {
      HOME: homeDir,
      LANG: BASE_LANG,
      PATH: [path.join(homeDir, "bin"), BASE_PATH].join(path.delimiter),
      ...extraEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: status === 0, stdout: stdout?.trim() ?? "", stderr: stderr?.trim() ?? "" };
}

function makeHome() {
  const homeDir = tempDirs.make("openclaw-ios-team-id-");
  mkdirSync(path.join(homeDir, "bin"));
  const preferences = path.join(homeDir, "Library", "Preferences");
  mkdirSync(preferences, { recursive: true });
  writeFileSync(path.join(preferences, "com.apple.dt.Xcode.plist"), "");
  writeExecutable(path.join(homeDir, "bin", "plutil"), "echo '{}'");
  writeExecutable(path.join(homeDir, "bin", "defaults"), "exit 0");
  return homeDir;
}

describe("scripts/ios-team-id.sh", () => {
  it("prefers the canonical OpenClaw iOS team when it is present", () => {
    const homeDir = makeHome();
    const fakePythonPath = path.join(homeDir, "bin", "fake-python");
    writeExecutable(
      fakePythonPath,
      `printf 'AAAAA11111\\t0\\tAlpha Team\\r\\n'
printf '${CANONICAL_TEAM_ID}\\t0\\tOpenClaw\\r\\n'`,
    );

    const result = runScript(homeDir, { IOS_PYTHON_BIN: fakePythonPath });
    expect(result).toMatchObject({ ok: true, stdout: CANONICAL_TEAM_ID });
  });

  it("loads teams from Xcode account identifier team metadata", () => {
    const homeDir = makeHome();
    writeExecutable(
      path.join(homeDir, "bin", "plutil"),
      `if [[ "$1" == "-extract" && "$2" == "IDEProvisioningTeamByIdentifier" ]]; then
  cat <<'JSON'
{"account-id":[{"teamID":"FWJYW4S8P8","teamName":"OpenClaw Foundation","isFreeProvisioningTeam":false,"teamType":"Company"}]}
JSON
  exit 0
fi
echo '{}'`,
    );

    const result = runScript(homeDir, { IOS_PYTHON_BIN: "python3" }, ["--require-canonical"]);
    expect(result).toMatchObject({ ok: true, stdout: CANONICAL_TEAM_ID });
  });

  it("fails canonical-only resolution when only fallback teams are available", () => {
    const homeDir = makeHome();
    const fakePythonPath = path.join(homeDir, "bin", "fake-python");
    writeExecutable(
      fakePythonPath,
      "printf 'AAAAA11111\\t1\\tAlpha Team\\r\\nBBBBB22222\\t0\\tBeta Team\\r\\n'",
    );
    const result = runScript(homeDir, { IOS_PYTHON_BIN: fakePythonPath }, ["--require-canonical"]);
    expect(result).toMatchObject({
      ok: false,
      stderr: expect.stringContaining(
        `Official OpenClaw iOS Team ID '${CANONICAL_TEAM_ID}' is not available`,
      ),
    });
  });

  it("rejects explicit non-canonical teams in canonical-only mode", () => {
    const result = runScript(makeHome(), { IOS_DEVELOPMENT_TEAM: "BBBBB22222" }, [
      "--require-canonical",
    ]);
    expect(result).toMatchObject({
      ok: false,
      stderr: expect.stringContaining("is not the official OpenClaw iOS team"),
    });
  });
});
