import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "run-openclaw-podman.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BASH_ARGS = process.platform === "win32" ? [SCRIPT] : ["--noprofile", "--norc", SCRIPT];
const BASE_PATH = process.env.PATH ?? "/usr/bin:/bin";
const BASE_LANG = process.env.LANG ?? "C";
let fixtureRoot = "";
let fakeBinDir = "";
let fakeHomeDir = "";
let fakePodmanLog = "";

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await writeFile(filePath, body, "utf8");
  chmodSync(filePath, 0o755);
}

async function runScript(extraEnv: Record<string, string> = {}): Promise<string[]> {
  await writeFile(fakePodmanLog, "", "utf8");
  const env = {
    HOME: fakeHomeDir,
    PATH: `${fakeBinDir}${path.delimiter}${BASE_PATH}`,
    LANG: BASE_LANG,
    OPENCLAW_PODMAN_USER: "testuser",
    OPENCLAW_GATEWAY_TOKEN: "test-token",
    FAKE_TEST_HOME: fakeHomeDir,
    FAKE_PODMAN_LOG: fakePodmanLog,
    ...extraEnv,
  };
  execFileSync(BASH_BIN, BASH_ARGS, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (await readFile(fakePodmanLog, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function findMounts(args: string[]): string[] {
  const mounts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-v" && args[i + 1]) {
      mounts.push(args[i + 1]);
    }
  }
  return mounts;
}

describe("scripts/run-openclaw-podman.sh", () => {
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-podman-"));
    fakeBinDir = path.join(fixtureRoot, "bin");
    fakeHomeDir = path.join(fixtureRoot, "home");
    fakePodmanLog = path.join(fixtureRoot, "podman.log");
    await mkdir(fakeBinDir, { recursive: true });
    await mkdir(fakeHomeDir, { recursive: true });

    await writeExecutable(
      path.join(fakeBinDir, "getent"),
      `#!/usr/bin/env bash
if [[ "$1" == "passwd" && "$2" == "testuser" ]]; then
  printf 'testuser:x:1234:1234::%s:/usr/sbin/nologin\n' "$FAKE_TEST_HOME"
  exit 0
fi
exit 2
`,
    );
    await writeExecutable(
      path.join(fakeBinDir, "id"),
      `#!/usr/bin/env bash
if [[ "$1" == "-u" && "$2" == "testuser" ]]; then
  echo 1234
  exit 0
fi
exec /usr/bin/id "$@"
`,
    );
    await writeExecutable(
      path.join(fakeBinDir, "getenforce"),
      `#!/usr/bin/env bash
printf '%s\n' "\${FAKE_GETENFORCE:-Disabled}"
`,
    );
    await writeExecutable(
      path.join(fakeBinDir, "podman"),
      `#!/usr/bin/env bash
set -euo pipefail
: "\${FAKE_PODMAN_LOG:?}"
printf '%s\n' "$@" > "$FAKE_PODMAN_LOG"
`,
    );
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("uses rw bind mounts when SELinux is disabled", async () => {
    const mounts = findMounts(await runScript({ FAKE_GETENFORCE: "Disabled" }));
    expect(mounts).toContain(`${fakeHomeDir}/.openclaw:/home/node/.openclaw:rw`);
    expect(mounts).toContain(
      `${fakeHomeDir}/.openclaw/workspace:/home/node/.openclaw/workspace:rw`,
    );
  });

  it("adds Z relabels when SELinux is enforcing", async () => {
    const mounts = findMounts(await runScript({ FAKE_GETENFORCE: "Enforcing" }));
    expect(mounts).toContain(`${fakeHomeDir}/.openclaw:/home/node/.openclaw:rw,Z`);
    expect(mounts).toContain(
      `${fakeHomeDir}/.openclaw/workspace:/home/node/.openclaw/workspace:rw,Z`,
    );
  });

  it("honors explicit bind mount option overrides", async () => {
    const mounts = findMounts(
      await runScript({
        FAKE_GETENFORCE: "Enforcing",
        OPENCLAW_BIND_MOUNT_OPTIONS: ":ro,z",
      }),
    );
    expect(mounts).toContain(`${fakeHomeDir}/.openclaw:/home/node/.openclaw:ro,z`);
    expect(mounts).toContain(
      `${fakeHomeDir}/.openclaw/workspace:/home/node/.openclaw/workspace:ro,z`,
    );
  });
});
