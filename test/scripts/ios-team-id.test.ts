import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-team-id.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BASH_ARGS = process.platform === "win32" ? [SCRIPT] : ["--noprofile", "--norc", SCRIPT];
const BASE_PATH = process.env.PATH ?? "/usr/bin:/bin";
const BASE_LANG = process.env.LANG ?? "C";
const CANONICAL_TEAM_ID = "FWJYW4S8P8";
let sharedBinDir = "";
let sharedHomeDir = "";
let sharedFakePythonPath = "";
const tempDirs: string[] = [];
async function writeExecutable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
}

function runScript(
  homeDir: string,
  extraEnv: Record<string, string> = {},
  scriptArgs: string[] = [],
) {
  const { status, stdout, stderr } = spawnSync(BASH_BIN, [...BASH_ARGS, ...scriptArgs], {
    env: {
      HOME: homeDir,
      LANG: BASE_LANG,
      PATH: [path.join(homeDir, "bin"), sharedBinDir, BASE_PATH].join(path.delimiter),
      ...extraEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: status === 0, stdout: stdout?.trim() ?? "", stderr: stderr?.trim() ?? "" };
}

async function makeHome() {
  const homeDir = makeTempDir(tempDirs, "openclaw-ios-team-id-");
  await mkdir(path.join(homeDir, "bin"), { recursive: true });
  const preferences = path.join(homeDir, "Library", "Preferences");
  await mkdir(preferences, { recursive: true });
  await writeFile(path.join(preferences, "com.apple.dt.Xcode.plist"), "");
  return homeDir;
}

describe("scripts/ios-team-id.sh", () => {
  beforeAll(async () => {
    const fixtureRoot = makeTempDir(tempDirs, "openclaw-ios-team-id-");
    sharedBinDir = path.join(fixtureRoot, "shared-bin");
    await mkdir(sharedBinDir, { recursive: true });
    sharedHomeDir = await makeHome();
    await writeExecutable(
      path.join(sharedBinDir, "plutil"),
      `#!/usr/bin/env bash
echo '{}'`,
    );
    await writeExecutable(path.join(sharedBinDir, "defaults"), "#!/usr/bin/env bash\nexit 0\n");
    sharedFakePythonPath = path.join(sharedHomeDir, "bin", "fake-python");
    await writeExecutable(
      sharedFakePythonPath,
      `#!/usr/bin/env bash
printf 'AAAAA11111\\t1\\tAlpha Team\\r\\n'
printf 'BBBBB22222\\t0\\tBeta Team\\r\\n'`,
    );
  });

  afterAll(() => cleanupTempDirs(tempDirs));

  it("prefers the canonical OpenClaw iOS team when it is present", async () => {
    const homeDir = await makeHome();
    const fakePythonPath = path.join(homeDir, "bin", "fake-python");
    await writeExecutable(
      fakePythonPath,
      `#!/usr/bin/env bash
printf 'AAAAA11111\\t0\\tAlpha Team\\r\\n'
printf '${CANONICAL_TEAM_ID}\\t0\\tOpenClaw\\r\\n'`,
    );

    const result = runScript(homeDir, { IOS_PYTHON_BIN: fakePythonPath });
    expect(result).toMatchObject({ ok: true, stdout: CANONICAL_TEAM_ID });
  });

  it("loads teams from Xcode account identifier team metadata", async () => {
    const homeDir = await makeHome();
    await writeExecutable(
      path.join(homeDir, "bin", "plutil"),
      `#!/usr/bin/env bash
if [[ "$1" == "-extract" && "$2" == "IDEProvisioningTeamByIdentifier" ]]; then
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
    const result = runScript(sharedHomeDir, { IOS_PYTHON_BIN: sharedFakePythonPath }, [
      "--require-canonical",
    ]);
    expect(result).toMatchObject({
      ok: false,
      stderr: expect.stringContaining(
        `Official OpenClaw iOS Team ID '${CANONICAL_TEAM_ID}' is not available`,
      ),
    });
  });

  it("rejects explicit non-canonical teams in canonical-only mode", () => {
    const result = runScript(sharedHomeDir, { IOS_DEVELOPMENT_TEAM: "BBBBB22222" }, [
      "--require-canonical",
    ]);
    expect(result).toMatchObject({
      ok: false,
      stderr: expect.stringContaining("is not the official OpenClaw iOS team"),
    });
  });
});
