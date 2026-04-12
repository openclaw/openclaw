import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "./test-helpers/temp-dir.js";

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
sync_exec_approvals() {
  local approvals_path="$OPENCLAW_CONFIG_DIR/exec-approvals.json"
  local security="$1"
  local ask="$2"
  local ask_fallback="$3"

  node - "$approvals_path" "$security" "$ask" "$ask_fallback" <<'NODE'
const fs = require("node:fs");
const [approvalsPath, security, ask, askFallback] = process.argv.slice(2);

let data = {};
if (fs.existsSync(approvalsPath)) {
  data = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));
}

if (!data || typeof data !== "object" || Array.isArray(data)) {
  throw new Error(\`Failed to parse \${approvalsPath}: expected a JSON object\`);
}

data.version ??= 1;
data.defaults = data.defaults && typeof data.defaults === "object" ? data.defaults : {};
data.agents = data.agents && typeof data.agents === "object" ? data.agents : {};
data.agents.main =
  data.agents.main && typeof data.agents.main === "object" ? data.agents.main : {};

for (const target of [data.defaults, data.agents.main]) {
  if (security) target.security = security;
  if (ask) target.ask = ask;
  if (askFallback) target.askFallback = askFallback;
}

fs.writeFileSync(approvalsPath, \`\${JSON.stringify(data, null, 2)}\\n\`, "utf8");
NODE
}
config_path_exists_in_stub() {
  local path="$1"
  local config_path="$OPENCLAW_CONFIG_DIR/openclaw.json"
  if [[ ! -f "$config_path" ]]; then
    return 1
  fi

  node - "$config_path" "$path" <<'NODE'
const fs = require("node:fs");
const vm = require("node:vm");
const configPath = process.argv[2];
const parts = process.argv[3].split(".");

try {
  const source = fs.readFileSync(configPath, "utf8");
  let current = vm.runInNewContext(\`(\${source})\`, Object.create(null), {
    timeout: 1000,
  });
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      process.exit(1);
    }
    current = current[part];
  }
  process.exit(0);
} catch {
  process.exit(1);
}
NODE
}
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
  if [[ "$*" == *"openclaw-playwright-chromium --version"* ]]; then
    echo "compose $*" >>"$log"
    if [[ "\${DOCKER_STUB_BROWSER_AVAILABLE:-1}" != "1" ]]; then
      exit 1
    fi
    exit 0
  fi
  if [[ "$*" == *"dist/index.js config get "* ]]; then
    args=("$@")
    path_index=$((\${#args[@]} - 1))
    if ! config_path_exists_in_stub "\${args[$path_index]}"; then
      echo "compose-fail $*" >>"$log"
      exit 1
    fi
  fi
  if [[ "$*" == *"--entrypoint node openclaw-gateway -e"* && "$*" == *"/home/node/.openclaw/exec-approvals.json"* ]]; then
    args=("$@")
    approvals_path_index=$((\${#args[@]} - 4))
    security_index=$((\${#args[@]} - 3))
    ask_index=$((\${#args[@]} - 2))
    ask_fallback_index=$((\${#args[@]} - 1))
    sync_exec_approvals \
      "\${args[$security_index]}" \
      "\${args[$ask_index]}" \
      "\${args[$ask_fallback_index]}"
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
  const rootDir = await sandboxRootTracker.make("suite");
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
    "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
  );
  await writeDockerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

const sandboxRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-docker-setup-" });

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
  return line.includes("compose") && line.includes(" up -d") && line.includes("openclaw-gateway");
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
    OPENCLAW_GATEWAY_TOKEN: undefined,
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_WORKSPACE_DIR: workspaceDir,
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
    await sandboxRootTracker.setup();
    sandbox = await createDockerSetupSandbox();
  });

  afterAll(async () => {
    if (!sandbox) {
      await sandboxRootTracker.cleanup();
      return;
    }
    await rm(sandbox.rootDir, { recursive: true, force: true });
    await sandboxRootTracker.cleanup();
    sandbox = null;
  });

  it("handles env defaults, home-volume mounts, and Docker build args", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      OPENCLAW_EXTRA_MOUNTS: undefined,
      OPENCLAW_HOME_VOLUME: "openclaw-home",
    });
    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
    expect(envFile).toContain("OPENCLAW_EXTRA_MOUNTS=");
    expect(envFile).toContain("OPENCLAW_HOME_VOLUME=openclaw-home"); // pragma: allowlist secret
    const extraCompose = await readFile(
      join(activeSandbox.rootDir, "docker-compose.extra.yml"),
      "utf8",
    );
    expect(extraCompose).toContain("openclaw-home:/home/node");
    expect(extraCompose).toContain("volumes:");
    expect(extraCompose).toContain("openclaw-home:");
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js onboard --mode local --no-install-daemon",
    );
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set gateway.mode local",
    );
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set gateway.bind lan",
    );
    expect(log).toContain(
      'run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set gateway.controlUi.allowedOrigins ["http://localhost:18789","http://127.0.0.1:18789"] --strict-json',
    );
    expect(log).not.toContain("run --rm openclaw-cli onboard --mode local --no-install-daemon");
  });

  it("avoids shared-network openclaw-cli before the gateway is started", async () => {
    const activeSandbox = requireSandbox(sandbox);

    await resetDockerLog(activeSandbox);
    const result = runDockerSetup(activeSandbox);
    expect(result.status).toBe(0);

    const lines = await readDockerLogLines(activeSandbox);
    const gatewayStartIdx = findGatewayStartLineIndex(lines);
    expect(gatewayStartIdx).toBeGreaterThanOrEqual(0);

    const prestartLines = lines.slice(0, gatewayStartIdx);
    expect(prestartLines.some((line) => /\bcompose\b.*\brun\b.*\bopenclaw-cli\b/.test(line))).toBe(
      false,
    );
  });

  it("forces BuildKit for local and sandbox docker builds", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(join(activeSandbox.rootDir, "Dockerfile.sandbox"), "FROM scratch\n");
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_SANDBOX: "1",
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
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const identityDirStat = await stat(join(configDir, "identity"));
    expect(identityDirStat.isDirectory()).toBe(true);
  });

  it("writes OPENCLAW_TZ into .env when given a real IANA timezone", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_TZ: "Asia/Shanghai",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_TZ=Asia/Shanghai");
  });

  it("configures Docker browser defaults when OPENCLAW_INSTALL_BROWSER is enabled", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_INSTALL_BROWSER: "1",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_BROWSER=1");
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set browser.enabled true",
    );
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set browser.defaultProfile openclaw",
    );
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set browser.headless true",
    );
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set browser.noSandbox true",
    );
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set browser.executablePath /usr/local/bin/openclaw-playwright-chromium",
    );
  });

  it("preserves explicit browser config when Docker browser defaults are applied", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    const configDir = join(activeSandbox.rootDir, "config-browser-explicit");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-browser-explicit");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "openclaw.json"),
      `{
        // JSON5 syntax should still count as explicitly configured.
        browser: {
          enabled: false,
          headless: false,
          executablePath: "/custom/browser",
        },
      }
      `,
    );

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_INSTALL_BROWSER: "1",
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config get browser.enabled",
    );
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config get browser.executablePath",
    );
    expect(log).not.toContain("config set browser.enabled true");
    expect(log).not.toContain("config set browser.headless true");
    expect(log).not.toContain(
      "config set browser.executablePath /usr/local/bin/openclaw-playwright-chromium",
    );
    expect(log).toContain("config set browser.defaultProfile openclaw");
    expect(log).toContain("config set browser.noSandbox true");
  });

  it("skips Docker browser defaults when the selected image lacks Chromium", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:latest",
      OPENCLAW_INSTALL_BROWSER: "1",
      DOCKER_STUB_BROWSER_AVAILABLE: "0",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("openclaw-playwright-chromium --version");
    expect(log).not.toContain("config set browser.enabled true");
    expect(log).not.toContain("config set browser.defaultProfile openclaw");
    expect(log).not.toContain("config set browser.headless true");
    expect(log).not.toContain("config set browser.noSandbox true");
    expect(log).not.toContain(
      "config set browser.executablePath /usr/local/bin/openclaw-playwright-chromium",
    );
  });

  it("applies Docker exec policy defaults and preserves existing allowlist entries", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    const configDir = join(activeSandbox.rootDir, "config-exec-policy");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-exec-policy");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
        },
        agents: {
          main: {
            allowlist: [{ pattern: "/usr/bin/uname" }],
          },
        },
      }),
    );

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_DOCKER_EXEC_SECURITY: "full",
      OPENCLAW_DOCKER_EXEC_ASK: "off",
      OPENCLAW_DOCKER_EXEC_ASK_FALLBACK: "full",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set tools.exec.security full",
    );
    expect(log).toContain(
      "run --rm --no-deps --user node --entrypoint node openclaw-gateway dist/index.js config set tools.exec.ask off",
    );
    expect(log).toContain("run --rm --no-deps --user node --entrypoint node openclaw-gateway -e");

    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_EXEC_SECURITY=full");
    expect(envFile).toContain("OPENCLAW_DOCKER_EXEC_ASK=off");
    expect(envFile).toContain("OPENCLAW_DOCKER_EXEC_ASK_FALLBACK=full");

    const approvals = JSON.parse(await readFile(join(configDir, "exec-approvals.json"), "utf8"));
    expect(approvals.defaults).toMatchObject({
      security: "full",
      ask: "off",
      askFallback: "full",
    });
    expect(approvals.agents.main).toMatchObject({
      security: "full",
      ask: "off",
      askFallback: "full",
    });
    expect(approvals.agents.main.allowlist).toEqual([{ pattern: "/usr/bin/uname" }]);
  });

  it("precreates agent data dirs to avoid EACCES in container", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const configDir = join(activeSandbox.rootDir, "config-agent-dirs");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-agent-dirs");

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
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
    expect(log).toContain("run --rm --no-deps --user root --entrypoint sh openclaw-gateway -c");
    expect(log).toContain("/home/node/.cache");
    expect(log).toContain("/home/node/.npm-global");
    expect(log).toContain("/home/node/go");
  });

  it("reuses existing config token when OPENCLAW_GATEWAY_TOKEN is unset", async () => {
    const activeSandbox = requireSandbox(sandbox);
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "token-reuse",
      async (configDir) => {
        await writeFile(
          join(configDir, "openclaw.json"),
          JSON.stringify({ gateway: { auth: { mode: "token", token: "config-token-123" } } }),
        );
      },
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=config-token-123"); // pragma: allowlist secret
  });

  it("reuses existing .env token when OPENCLAW_GATEWAY_TOKEN and config token are unset", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(
      join(activeSandbox.rootDir, ".env"),
      "OPENCLAW_GATEWAY_TOKEN=dotenv-token-123\nOPENCLAW_GATEWAY_PORT=18789\n", // pragma: allowlist secret
    );
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "dotenv-token-reuse",
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=dotenv-token-123"); // pragma: allowlist secret
    expect(result.stderr).toBe("");
  });

  it("reuses the last non-empty .env token and strips CRLF without truncating '='", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await writeFile(
      join(activeSandbox.rootDir, ".env"),
      [
        "OPENCLAW_GATEWAY_TOKEN=",
        "OPENCLAW_GATEWAY_TOKEN=first-token",
        "OPENCLAW_GATEWAY_TOKEN=last=token=value\r", // pragma: allowlist secret
      ].join("\n"),
    );
    const { result, envFile } = await runDockerSetupWithUnsetGatewayToken(
      activeSandbox,
      "dotenv-last-wins",
    );

    expect(result.status).toBe(0);
    expect(envFile).toContain("OPENCLAW_GATEWAY_TOKEN=last=token=value"); // pragma: allowlist secret
    expect(envFile).not.toContain("OPENCLAW_GATEWAY_TOKEN=first-token");
    expect(envFile).not.toContain("\r");
  });

  it("treats OPENCLAW_SANDBOX=0 as disabled", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_SANDBOX: "0",
    });

    expect(result.status).toBe(0);
    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_SANDBOX=");

    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_DOCKER_CLI=");
    expect(log).not.toContain("--build-arg OPENCLAW_INSTALL_DOCKER_CLI=1");
    expect(log).toContain("config set agents.defaults.sandbox.mode off");
  });

  it("resets stale sandbox mode and overlay when sandbox is not active", async () => {
    const activeSandbox = requireSandbox(sandbox);
    await resetDockerLog(activeSandbox);
    await writeFile(
      join(activeSandbox.rootDir, "docker-compose.sandbox.yml"),
      "services:\n  openclaw-gateway:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
    );

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_SANDBOX: "1",
      DOCKER_STUB_FAIL_MATCH: "--entrypoint docker openclaw-gateway --version",
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
        OPENCLAW_SANDBOX: "1",
        OPENCLAW_DOCKER_SOCKET: socketPath,
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
        "run --rm --no-deps openclaw-cli config set agents.defaults.sandbox.mode non-main",
      );
      expect(log).toContain("config set agents.defaults.sandbox.mode off");
      const forceRecreateLine = log
        .split("\n")
        .find((line) => line.includes("up -d --force-recreate openclaw-gateway"));
      expect(forceRecreateLine).toBeDefined();
      expect(forceRecreateLine).not.toContain("docker-compose.sandbox.yml");
      await expect(
        stat(join(activeSandbox.rootDir, "docker-compose.sandbox.yml")),
      ).rejects.toThrow();
    });
  });

  it("rejects injected multiline OPENCLAW_EXTRA_MOUNTS values", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_EXTRA_MOUNTS: "/tmp:/tmp\n  evil-service:\n    image: alpine",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_EXTRA_MOUNTS cannot contain control characters");
  });

  it("rejects invalid OPENCLAW_EXTRA_MOUNTS mount format", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_EXTRA_MOUNTS: "bad mount spec",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid mount format");
  });

  it("rejects invalid OPENCLAW_HOME_VOLUME names", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_HOME_VOLUME: "bad name",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_HOME_VOLUME must match");
  });

  it("rejects OPENCLAW_TZ values that are not present in zoneinfo", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_TZ: "Nope/Bad",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_TZ must match a timezone in /usr/share/zoneinfo");
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
    expect(compose).toContain('network_mode: "service:openclaw-gateway"');
    expect(compose).toContain(
      "depends_on:\n      openclaw-gateway:\n        condition: service_started",
    );
  });

  it("keeps docker-compose gateway token env defaults aligned across services", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/OPENCLAW_GATEWAY_TOKEN: \$\{OPENCLAW_GATEWAY_TOKEN:-\}/g)).toHaveLength(
      2,
    );
  });

  it("keeps docker-compose timezone env defaults aligned across services", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose.match(/TZ: \$\{OPENCLAW_TZ:-UTC\}/g)).toHaveLength(2);
  });

  it("allowlists Docker runtime env keys instead of injecting the full project .env", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("env_file:");
    expect(compose).not.toContain("/app/.env:ro");
  });

  it("bootstraps node-owned runtime dirs before starting the gateway", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain("openclaw-init:");
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).toContain(
      'mkdir -p /home/node/.cache /home/node/.npm "${PNPM_HOME:-/home/node/.local/share/pnpm}"',
    );
    expect(compose).toContain(
      "chown -R node:node /home/node/.cache /home/node/.local /home/node/.npm",
    );
  });

  it("keeps the gateway on the image-default user while the init service runs as root", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/openclaw-init:[\s\S]*?\n\s+user: root/);
    expect(compose).not.toMatch(/openclaw-gateway:[\s\S]*?\n\s+user: root/);
    expect(compose).not.toContain('entrypoint: ["/app/scripts/docker/gateway-entrypoint.sh"]');
  });
});
