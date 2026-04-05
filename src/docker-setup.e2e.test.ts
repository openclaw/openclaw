import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
fail_match="\${DOCKER_STUB_FAIL_MATCH:-}"
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  if [[ -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
    echo "build-fail $*" >>"$log"
    exit 1
  fi
  echo "build DOCKER_BUILDKIT=\${DOCKER_BUILDKIT:-} $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  if [[ -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
    echo "compose-fail $*" >>"$log"
    exit 1
  fi
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
  const rootDir = await mkdtemp(join(tmpdir(), "mullusi-docker-setup-"));
  const scriptPath = join(rootDir, "scripts", "docker", "setup.sh");
  const dockerfilePath = join(rootDir, "Dockerfile");
  const composePath = join(rootDir, "docker-compose.yml");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "docker-stub.log");

  await mkdir(join(rootDir, "scripts", "docker"), { recursive: true });
  await copyFile(join(repoRoot, "scripts", "docker", "setup.sh"), scriptPath);
  await chmod(scriptPath, 0o755);
  await writeFile(dockerfilePath, "FROM scratch\n");
  await writeFile(
    composePath,
    "services:\n  mullusi-gateway:\n    image: noop\n  mullusi-cli:\n    image: noop\n",
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
    MULLUSI_GATEWAY_TOKEN: "test-token",
    MULLUSI_CONFIG_DIR: join(sandbox.rootDir, "config"),
    MULLUSI_WORKSPACE_DIR: join(sandbox.rootDir, "mullusi"),
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

async function resetDockerLog(sandbox: DockerSetupSandbox) {
  await writeFile(sandbox.logPath, "");
}

async function readDockerLog(sandbox: DockerSetupSandbox) {
  return readFile(sandbox.logPath, "utf8");
}

async function readDockerLogLines(sandbox: DockerSetupSandbox) {
  return (await readDockerLog(sandbox)).split("\n").filter(Boolean);
}

function isGatewayStartLine(line: string) {
  return line.includes("compose") && line.includes(" up -d") && line.includes("mullusi-gateway");
}

function findGatewayStartLineIndex(lines: string[]) {
  return lines.findIndex((line) => isGatewayStartLine(line));
}

async function runDockerSetupWithUnsetGatewayToken(
  sandbox: DockerSetupSandbox,
  suffix: string,
  prepare?: (configDir: string) => Promise<void>,
) {
  const configDir = join(sandbox.rootDir, `config-${suffix}`);
  const workspaceDir = join(sandbox.rootDir, `workspace-${suffix}`);
  await mkdir(configDir, { recursive: true });
  await prepare?.(configDir);

  const result = runDockerSetup(sandbox, {
    MULLUSI_GATEWAY_TOKEN: undefined,
    MULLUSI_CONFIG_DIR: configDir,
    MULLUSI_WORKSPACE_DIR: workspaceDir,
  });
  const envFile = await readFile(join(sandbox.rootDir, ".env"), "utf8");

  return { result, envFile };
}

async function withUnixSocket<T>(socketPath: string, run: () => Promise<T>): Promise<T> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  try {
    return await run();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
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

describe("scripts/docker/setup.sh", () => {
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

  it("handles env defaults, home-volume mounts, and Docker build args", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      MULLUSI_EXTRA_MOUNTS: undefined,
      MULLUSI_HOME_VOLUME: "mullusi-home",
    });
    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("MULLUSI_DOCKER_APT_PACKAGES=ffmpeg build-essential");
    expect(envFile).toContain("MULLUSI_EXTRA_MOUNTS=");
    expect(envFile).toContain("MULLUSI_HOME_VOLUME=mullusi-home"); // pragma: allowlist secret
    const extraCompose = await readFile(
      join(activeSandbox.rootDir, "docker-compose.extra.yml"),
      "utf8",
    );
    expect(extraCompose).toContain("mullusi-home:/home/node");
    expect(extraCompose).toContain("volumes:");
    expect(extraCompose).toContain("mullusi-home:");
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg MULLUSI_DOCKER_APT_PACKAGES=ffmpeg build-essential");
    expect(log).toContain(
      "run --rm --no-deps --entrypoint node mullusi-gateway dist/index.js onboard --mode local --no-install-daemon",
    );
    expect(log).toContain(
      "run --rm --no-deps --entrypoint node mullusi-gateway dist/index.js config set gateway.mode local",
    );
    expect(log).toContain(
      "run --rm --no-deps --entrypoint node mullusi-gateway dist/index.js config set gateway.bind lan",
    );
    expect(log).toContain(
      'run --rm --no-deps --entrypoint node mullusi-gateway dist/index.js config set gateway.controlUi.allowedOrigins ["http://localhost:18790","http://127.0.0.1:18790"] --strict-json',
    );
    expect(log).not.toContain("run --rm mullusi-cli onboard --mode local --no-install-daemon");
  });

  it("avoids shared-network mullusi-cli before the gateway is started", async () => {
    const activeSandbox = requireSandbox(sandbox);

    await resetDockerLog(activeSandbox);
    const result = runDockerSetup(activeSandbox);
    expect(result.status).toBe(0);

    const lines = await readDockerLogLines(activeSandbox);
    const gatewayStartIdx = findGatewayStartLineIndex(lines);
    expect(gatewayStartIdx).toBeGreaterThanOrEqual(0);

    const prestartLines = lines.slice(0, gatewayStartIdx);
    expect(prestartLines.some((line) => /\bcompose\b.*\brun\b.*\bmullusi-cli\b/.test(line))).toBe(
      false,
    );
  });

  it("forces BuildKit for local and sandbox docker builds", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(join(activeSandbox.rootDir, "Dockerfile.sandbox"), "FROM scratch\n");
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_SANDBOX: "1",
    });

    expect(result.status).toBe(0);
    const buildLines = (await readDockerLogLines(activeSandbox)).filter((line) =>
      line.startsWith("build "),
    );
    expect(buildLines.length).toBeGreaterThanOrEqual(2);
    expect(buildLines.every((line) => line.includes("DOCKER_BUILDKIT=1"))).toBe(true);
  });

  it("precreates config identity dir for CLI device auth writes", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-identity");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-identity");

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_CONFIG_DIR: configDir,
      MULLUSI_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const identityDirStat = await stat(join(configDir, "identity"));
    expect(identityDirStat.isDirectory()).toBe(true);
  });

  it("writes MULLUSI_TZ into .env when given a real IANA timezone", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_TZ: "Asia/Shanghai",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("MULLUSI_TZ=Asia/Shanghai");
  });

  it("precreates agent data dirs to avoid EACCES in container", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-agent-dirs");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-agent-dirs");

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_CONFIG_DIR: configDir,
      MULLUSI_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const agentDirStat = await stat(join(configDir, "agents", "main", "agent"));
    expect(agentDirStat.isDirectory()).toBe(true);
    const sessionsDirStat = await stat(join(configDir, "agents", "main", "sessions"));
    expect(sessionsDirStat.isDirectory()).toBe(true);

    // Verify that a root-user chown step runs before setup.
    const log = await readDockerLog(activeSandbox);
    const chownIdx = log.indexOf("--user root");
    const onboardIdx = log.indexOf("onboard");
    expect(chownIdx).toBeGreaterThanOrEqual(0);
    expect(onboardIdx).toBeGreaterThan(chownIdx);
    expect(log).toContain("run --rm --no-deps --user root --entrypoint sh mullusi-gateway -c");
  });

  it("reuses existing config token when MULLUSI_GATEWAY_TOKEN is unset", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "token-reuse",
      async (configDir) => {
        await writeFile(
          join(configDir, "mullusi.json"),
          JSON.stringify({ gateway: { auth: { mode: "token", token: "config-token-123" } } }),
        );
      },
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("MULLUSI_GATEWAY_TOKEN=config-token-123"); // pragma: allowlist secret
  });

  it("reuses existing .env token when MULLUSI_GATEWAY_TOKEN and config token are unset", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(
      join(activeSandbox.rootDir, ".env"),
      "MULLUSI_GATEWAY_TOKEN=dotenv-token-123\nMULLUSI_GATEWAY_PORT=18790\n", // pragma: allowlist secret
    );
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "dotenv-token-reuse",
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("MULLUSI_GATEWAY_TOKEN=dotenv-token-123"); // pragma: allowlist secret
    expect(result.stderr).toBe("");
  });

  it("reuses the last non-empty .env token and strips CRLF without truncating '='", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(
      join(activeSandbox.rootDir, ".env"),
      [
        "MULLUSI_GATEWAY_TOKEN=",
        "MULLUSI_GATEWAY_TOKEN=first-token",
        "MULLUSI_GATEWAY_TOKEN=last=token=value\r", // pragma: allowlist secret
      ].join("\n"),
    );
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "dotenv-last-wins",
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("MULLUSI_GATEWAY_TOKEN=last=token=value"); // pragma: allowlist secret
    expect(envFile).not.toContain("MULLUSI_GATEWAY_TOKEN=first-token");
    expect(envFile).not.toContain("\r");
  });

  it("treats MULLUSI_SANDBOX=0 as disabled", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_SANDBOX: "0",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("MULLUSI_SANDBOX=");

    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg MULLUSI_INSTALL_DOCKER_CLI=");
    expect(log).not.toContain("--build-arg MULLUSI_INSTALL_DOCKER_CLI=1");
    expect(log).toContain("config set agents.defaults.sandbox.mode off");
  });

  it("resets stale sandbox mode and overlay when sandbox is not active", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    await writeFile(
      join(activeSandbox.rootDir, "docker-compose.sandbox.yml"),
      "services:\n  mullusi-gateway:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
    );

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_SANDBOX: "1",
      DOCKER_STUB_FAIL_MATCH: "--entrypoint docker mullusi-gateway --version",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Sandbox requires Docker CLI");
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("config set agents.defaults.sandbox.mode off");
    await expect(stat(join(activeSandbox.rootDir, "docker-compose.sandbox.yml"))).rejects.toThrow();
  });

  it("skips sandbox gateway restart when sandbox config writes fail", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    const socketPath = join(activeSandbox.rootDir, "sandbox.sock");

    await withUnixSocket(socketPath, async () => {
      const result = runDockerSetup(activeSandbox, {
        MULLUSI_SANDBOX: "1",
        MULLUSI_DOCKER_SOCKET: socketPath,
        DOCKER_STUB_FAIL_MATCH: "config set agents.defaults.sandbox.scope",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Failed to set agents.defaults.sandbox.scope");
      expect(result.stderr).toContain("Skipping gateway restart to avoid exposing Docker socket");

      const log = await readDockerLog(activeSandbox);
      const gatewayStarts = (await readDockerLogLines(activeSandbox)).filter((line) =>
        isGatewayStartLine(line),
      );
      expect(gatewayStarts).toHaveLength(2);
      expect(log).toContain(
        "run --rm --no-deps mullusi-cli config set agents.defaults.sandbox.mode non-main",
      );
      expect(log).toContain("config set agents.defaults.sandbox.mode off");
      const forceRecreateLine = log
        .split("\n")
        .find((line) => line.includes("up -d --force-recreate mullusi-gateway"));
      expect(forceRecreateLine).toBeDefined();
      expect(forceRecreateLine).not.toContain("docker-compose.sandbox.yml");
      await expect(
        stat(join(activeSandbox.rootDir, "docker-compose.sandbox.yml")),
      ).rejects.toThrow();
    });
  });

  it("rejects injected multiline MULLUSI_EXTRA_MOUNTS values", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_EXTRA_MOUNTS: "/tmp:/tmp\n  evil-service:\n    image: alpine",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MULLUSI_EXTRA_MOUNTS cannot contain control characters");
  });

  it("rejects invalid MULLUSI_EXTRA_MOUNTS mount format", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_EXTRA_MOUNTS: "bad mount spec",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid mount format");
  });

  it("rejects invalid MULLUSI_HOME_VOLUME names", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_HOME_VOLUME: "bad name",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MULLUSI_HOME_VOLUME must match");
  });

  it("rejects MULLUSI_TZ values that are not present in zoneinfo", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      MULLUSI_TZ: "Nope/Bad",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MULLUSI_TZ must match a timezone in /usr/share/zoneinfo");
  });

  it("avoids associative arrays so the script remains Bash 3.2-compatible", async () => {
    const script = await readFile(join(repoRoot, "scripts", "docker", "setup.sh"), "utf8");
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

    const syntaxCheck = spawnSync(
      systemBash,
      ["-n", join(repoRoot, "scripts", "docker", "setup.sh")],
      {
        encoding: "utf8",
      },
    );

    expect(syntaxCheck.status).toBe(0);
    expect(syntaxCheck.stderr).not.toContain("declare: -A: invalid option");
  });

  it("keeps docker-compose gateway command in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("gateway-daemon");
    expect(compose).toContain('"gateway"');
  });

  it("keeps docker-compose CLI network namespace settings in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain('network_mode: "service:mullusi-gateway"');
    expect(compose).toContain("depends_on:\n      - mullusi-gateway");
  });

  it("keeps docker-compose gateway token env defaults aligned across services", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/MULLUSI_GATEWAY_TOKEN: \$\{MULLUSI_GATEWAY_TOKEN:-\}/g)).toHaveLength(
      2,
    );
  });

  it("keeps docker-compose timezone env defaults aligned across services", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/TZ: \$\{MULLUSI_TZ:-UTC\}/g)).toHaveLength(2);
  });
});
