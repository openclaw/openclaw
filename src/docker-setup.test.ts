import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type DockerSetupSandbox = {
  rootDir: string;
  scriptPath: string;
  logPath: string;
  binDir: string;
};

async function writeDockerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  echo "build $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  echo "compose $*" >>"$log"
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(logPath, "");
}

async function createDockerSetupSandbox(): Promise<DockerSetupSandbox> {
  const rootDir = await mkdtemp(join(tmpdir(), "activi-docker-setup-"));
  const scriptPath = join(rootDir, "docker-setup.sh");
  const dockerfilePath = join(rootDir, "Dockerfile");
  const composePath = join(rootDir, "docker-compose.yml");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "docker-stub.log");

  await copyFile(join(repoRoot, "docker-setup.sh"), scriptPath);
  await chmod(scriptPath, 0o755);
  await writeFile(dockerfilePath, "FROM scratch\n");
  await writeFile(
    composePath,
    "services:\n  activi-gateway:\n    image: noop\n  activi-cli:\n    image: noop\n",
  );
  await writeDockerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

function createEnv(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? sandbox.rootDir,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    DOCKER_STUB_LOG: sandbox.logPath,
    ACTIVI_GATEWAY_TOKEN: "test-token",
    ACTIVI_CONFIG_DIR: join(sandbox.rootDir, "config"),
    ACTIVI_WORKSPACE_DIR: join(sandbox.rootDir, "activi"),
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function requireSandbox(sandbox: DockerSetupSandbox | null): DockerSetupSandbox {
  if (!sandbox) {
    throw new Error("sandbox missing");
  }
  return sandbox;
}

function runDockerSetup(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
) {
  return spawnSync("bash", [sandbox.scriptPath], {
    cwd: sandbox.rootDir,
    env: createEnv(sandbox, overrides),
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function resolveBashForCompatCheck(): string | null {
  for (const candidate of ["/bin/bash", "bash"]) {
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

describe("docker-setup.sh", () => {
  let sandbox: DockerSetupSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createDockerSetupSandbox();
  });

  afterAll(async () => {
    if (!sandbox) {
      return;
    }
    await rm(sandbox.rootDir, { recursive: true, force: true });
    sandbox = null;
  });

  it("handles env defaults, home-volume mounts, and apt build args", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      ACTIVI_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      ACTIVI_EXTRA_MOUNTS: undefined,
      ACTIVI_HOME_VOLUME: "activi-home",
    });
    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("ACTIVI_DOCKER_APT_PACKAGES=ffmpeg build-essential");
    expect(envFile).toContain("ACTIVI_EXTRA_MOUNTS=");
    expect(envFile).toContain("ACTIVI_HOME_VOLUME=activi-home");
    const extraCompose = await readFile(
      join(activeSandbox.rootDir, "docker-compose.extra.yml"),
      "utf8",
    );
    expect(extraCompose).toContain("activi-home:/home/node");
    expect(extraCompose).toContain("volumes:");
    expect(extraCompose).toContain("activi-home:");
    const log = await readFile(activeSandbox.logPath, "utf8");
    expect(log).toContain("--build-arg ACTIVI_DOCKER_APT_PACKAGES=ffmpeg build-essential");
  });

  it("rejects injected multiline ACTIVI_EXTRA_MOUNTS values", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      ACTIVI_EXTRA_MOUNTS: "/tmp:/tmp\n  evil-service:\n    image: alpine",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ACTIVI_EXTRA_MOUNTS cannot contain control characters");
  });

  it("rejects invalid ACTIVI_EXTRA_MOUNTS mount format", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      ACTIVI_EXTRA_MOUNTS: "bad mount spec",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid mount format");
  });

  it("rejects invalid ACTIVI_HOME_VOLUME names", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      ACTIVI_HOME_VOLUME: "bad name",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ACTIVI_HOME_VOLUME must match");
  });

  it("avoids associative arrays so the script remains Bash 3.2-compatible", async () => {
    const script = await readFile(join(repoRoot, "docker-setup.sh"), "utf8");
    expect(script).not.toMatch(/^\s*declare -A\b/m);

    const systemBash = resolveBashForCompatCheck();
    if (!systemBash) {
      return;
    }

    const assocCheck = spawnSync(systemBash, ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status === 0 || assocCheck.status === null) {
      // Skip runtime check when system bash supports associative arrays
      // (not Bash 3.2) or when /bin/bash is unavailable (e.g. Windows).
      return;
    }

    const syntaxCheck = spawnSync(systemBash, ["-n", join(repoRoot, "docker-setup.sh")], {
      encoding: "utf8",
    });

    expect(syntaxCheck.status).toBe(0);
    expect(syntaxCheck.stderr).not.toContain("declare: -A: invalid option");
  });

  it("keeps docker-compose gateway command in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("gateway-daemon");
    expect(compose).toContain('"gateway"');
  });
});
