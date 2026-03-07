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

function toBashPath(value: string): string {
  if (process.platform !== "win32") {
    return value;
  }
  const normalized = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `/mnt/${normalized.slice(0, 1).toLowerCase()}${normalized.slice(2)}`;
  }
  return normalized;
}

function resolveBashPathEnv(): string {
  if (process.platform !== "win32") {
    return process.env.PATH ?? "";
  }
  const probe = spawnSync("bash", ["-lc", 'printf %s "$PATH"'], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) {
    return probe.stdout.trim();
  }
  return process.env.PATH ?? "";
}

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
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-docker-setup-"));
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
    "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
  );
  await writeDockerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

function createEnv(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const pathEntries =
    process.platform === "win32"
      ? [toBashPath(sandbox.binDir), resolveBashPathEnv()]
      : [sandbox.binDir, process.env.PATH ?? ""];
  const env: NodeJS.ProcessEnv = {
    PATH: pathEntries.filter(Boolean).join(":"),
    HOME: process.env.HOME ?? sandbox.rootDir,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    DOCKER_STUB_LOG: sandbox.logPath,
    OPENCLAW_GATEWAY_TOKEN: "test-token",
    OPENCLAW_CONFIG_DIR: join(sandbox.rootDir, "config"),
    OPENCLAW_WORKSPACE_DIR: join(sandbox.rootDir, "openclaw"),
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

function resolveBashForCompatCheck(): string | null {
  for (const candidate of ["/bin/bash", "bash"]) {
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

function resolveBashCommand(): string {
  if (process.platform !== "win32") {
    return "bash";
  }
  const probe = spawnSync("where", ["bash"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = probe.stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  }
  return "bash";
}

function bashQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createBashEnv(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env = createEnv(sandbox, overrides);
  if (process.platform !== "win32") {
    return env;
  }
  return {
    ...env,
    HOME: toBashPath(env.HOME ?? sandbox.rootDir),
    OPENCLAW_CONFIG_DIR: toBashPath(join(sandbox.rootDir, "config")),
    OPENCLAW_WORKSPACE_DIR: toBashPath(join(sandbox.rootDir, "openclaw")),
  };
}

function runDockerSetupScript(
  sandbox: DockerSetupSandbox,
  overrides: Record<string, string | undefined> = {},
) {
  const bashCommand = resolveBashCommand();
  if (process.platform !== "win32") {
    return spawnSync("bash", [sandbox.scriptPath], {
      cwd: sandbox.rootDir,
      env: createEnv(sandbox, overrides),
      stdio: ["ignore", "ignore", "pipe"],
    });
  }

  const logPath = bashQuote(toBashPath(sandbox.logPath));
  const scriptPath = bashQuote(toBashPath(sandbox.scriptPath));
  const script = `
docker() {
  if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
    return 0
  fi
  if [[ "\${1:-}" == "build" ]]; then
    echo "build $*" >>${logPath}
    return 0
  fi
  if [[ "\${1:-}" == "compose" ]]; then
    echo "compose $*" >>${logPath}
    return 0
  fi
  echo "unknown $*" >>${logPath}
  return 0
}
source ${scriptPath}
`;

  return spawnSync(bashCommand, ["-lc", script], {
    cwd: sandbox.rootDir,
    env: createBashEnv(sandbox, overrides),
    stdio: ["ignore", "ignore", "pipe"],
  });
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
    if (!sandbox) {
      throw new Error("sandbox missing");
    }
    if (process.platform === "win32") {
      return;
    }

    const result = runDockerSetupScript(sandbox, {
      OPENCLAW_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      OPENCLAW_EXTRA_MOUNTS: undefined,
      OPENCLAW_HOME_VOLUME: "openclaw-home",
    });
    expect(result.status).toBe(0);
    const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
    expect(envFile).toContain("OPENCLAW_EXTRA_MOUNTS=");
    expect(envFile).toContain("OPENCLAW_HOME_VOLUME=openclaw-home");
    const extraCompose = await readFile(join(sandbox.rootDir, "docker-compose.extra.yml"), "utf8");
    expect(extraCompose).toContain("openclaw-home:/home/node");
    expect(extraCompose).toContain("volumes:");
    expect(extraCompose).toContain("openclaw-home:");
    const log = await readFile(sandbox.logPath, "utf8");
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
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
