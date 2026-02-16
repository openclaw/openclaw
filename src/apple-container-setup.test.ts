import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type ContainerSetupSandbox = {
  rootDir: string;
  scriptPath: string;
  logPath: string;
  binDir: string;
};

async function writeContainerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$CONTAINER_STUB_LOG"
if [[ "\${1:-}" == "build" ]]; then
  echo "build $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  echo "run $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "rm" ]]; then
  echo "rm $*" >>"$log"
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "container"), stub, { mode: 0o755 });
  await writeFile(logPath, "");
}

async function createContainerSetupSandbox(): Promise<ContainerSetupSandbox> {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-apple-container-setup-"));
  const scriptPath = join(rootDir, "apple-container-setup.sh");
  const dockerfilePath = join(rootDir, "Dockerfile");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "container-stub.log");

  const script = await readFile(join(repoRoot, "apple-container-setup.sh"), "utf8");
  await writeFile(scriptPath, script, { mode: 0o755 });
  await writeFile(dockerfilePath, "FROM scratch
");
  await writeContainerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

function createEnv(
  sandbox: ContainerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
    CONTAINER_STUB_LOG: sandbox.logPath,
    OPENCLAW_GATEWAY_TOKEN: "test-token",
    OPENCLAW_CONFIG_DIR: join(sandbox.rootDir, "config"),
    OPENCLAW_WORKSPACE_DIR: join(sandbox.rootDir, "openclaw"),
    ...overrides,
  };
}

describe("apple-container-setup.sh", () => {
  it("handles unset optional env vars", async () => {
    const sandbox = await createContainerSetupSandbox();
    const env = createEnv(sandbox, {
      OPENCLAW_DOCKER_APT_PACKAGES: undefined,
      OPENCLAW_EXTRA_MOUNTS: undefined,
      OPENCLAW_HOME_VOLUME: undefined,
    });

    const result = spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=");
    expect(envFile).toContain("OPENCLAW_EXTRA_MOUNTS=");
    expect(envFile).toContain("OPENCLAW_HOME_VOLUME=");
  });

  it("plumbs OPENCLAW_DOCKER_APT_PACKAGES into .env and container build args", async () => {
    const sandbox = await createContainerSetupSandbox();
    const env = createEnv(sandbox, {
      OPENCLAW_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      OPENCLAW_EXTRA_MOUNTS: "",
      OPENCLAW_HOME_VOLUME: "",
    });

    const result = spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");

    const log = await readFile(sandbox.logPath, "utf8");
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
  });

  it("handles extra mounts and home volume in container run", async () => {
    const sandbox = await createContainerSetupSandbox();
    const env = createEnv(sandbox, {
      OPENCLAW_EXTRA_MOUNTS: "/tmp/data:/data",
      OPENCLAW_HOME_VOLUME: "openclaw-home",
    });

    const result = spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const log = await readFile(sandbox.logPath, "utf8");
    expect(log).toContain("-v openclaw-home:/home/node");
    expect(log).toContain("-v /tmp/data:/data");
  });

  it("avoids associative arrays for Bash 3.2 compatibility", async () => {
    const script = await readFile(join(repoRoot, "apple-container-setup.sh"), "utf8");
    expect(script).not.toMatch(/^\s*declare -A\b/m);
  });
});
