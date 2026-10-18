import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../src/infra/tmp-openclaw-dir.js";
import { createSuiteTempRootTracker } from "../../src/test-helpers/temp-dir.js";

export const repoRoot = resolve(import.meta.dirname, "../..");

export type DockerSetupSandbox = Awaited<ReturnType<typeof createDockerSetupSandbox>>;

const sandboxRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-docker-setup-",
  parentDir: resolvePreferredOpenClawTmpDir(),
});

export const setupDockerSetupSandboxRoot = sandboxRootTracker.setup;
export const cleanupDockerSetupSandboxRoot = sandboxRootTracker.cleanup;

async function writeDockerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
fail_match="\${DOCKER_STUB_FAIL_MATCH:-}"
docker_host=""
if [[ "\${1:-}" == "--host" ]]; then
  docker_host="\${2:-}"
  shift 2
fi
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "compose" && -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
  echo "$1-fail $*" >>"$log"
  exit 1
fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  format=""
  image="\${3:-}"
  if [[ "\${3:-}" == "-f" || "\${3:-}" == "--format" ]]; then
    format="\${4:-}"
    image="\${5:-}"
  fi
  echo "image inspect $image host=$docker_host" >>"$log"
  missing_images=",\${DOCKER_STUB_MISSING_IMAGES:-},"
  [[ "$missing_images" != *",$image,"* ]] || exit 1
  [[ -z "$format" ]] || printf '%s\n' "\${DOCKER_STUB_BROWSER_CONTRACT:-<no value>}"
  exit 0
fi
if [[ "\${1:-}" == "pull" ]]; then
  echo "pull $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  echo "build DOCKER_BUILDKIT=\${DOCKER_BUILDKIT:-} $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  echo "run $*" >>"$log"
  args=("$@")
  for ((i = 0; i + 3 < \${#args[@]}; i++)); do
    [[ "\${args[$i]}" == "--entrypoint" && "\${args[$((i + 1))]}" == "node" ]] || continue
    for ((j = i + 2; j + 1 < \${#args[@]}; j++)); do
      [[ "\${args[$j]}" == "-e" ]] || continue
      exec node -e "\${args[$((j + 1))]}" "\${args[@]:$((j + 2))}"
    done
  done
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  echo "compose $*" >>"$log"
  empty_json='{}'
  case "$*" in
    *"config get gateway.controlUi.allowedOrigins"*) printf '%s\n' "\${DOCKER_STUB_CONTROL_UI_ORIGINS:-}"; exit 0 ;;
    *"config get gateway.publicOrigin"*) printf '%s\n' "\${DOCKER_STUB_PUBLIC_ORIGIN:-}"; exit 0 ;;
    *"config get tools.sandbox.tools --json"*) printf '%s\n' "\${DOCKER_STUB_SANDBOX_TOOLS_JSON:-$empty_json}"; exit 0 ;;
    *"config get agents --json"*) printf '%s\n' "\${DOCKER_STUB_AGENTS_JSON:-$empty_json}"; exit 0 ;;
  esac
  args=("$@")
  for ((i = 0; i + 4 < \${#args[@]}; i++)); do
    [[ "\${args[$i]}" == "--entrypoint" &&
      "\${args[$((i + 1))]}" == "node" &&
      "\${args[$((i + 2))]}" == "openclaw-gateway" &&
      "\${args[$((i + 3))]}" == "-e" ]] || continue
    exec node -e "\${args[$((i + 4))]}" "\${args[@]:$((i + 5))}"
  done
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  const timeoutStub = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == --kill-after=* ]]; then
  shift
elif [[ "\${1:-}" == "--kill-after" ]]; then
  shift 2
fi
if [[ $# -gt 0 ]]; then
  shift
fi
exec "$@"
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(join(binDir, "timeout"), timeoutStub, { mode: 0o755 });
  await writeFile(logPath, "");
}

export async function expectMissingPath(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

export async function createDockerSetupSandbox() {
  const rootDir = await sandboxRootTracker.make("suite");
  const scriptPath = join(rootDir, "scripts", "docker", "setup.sh");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "docker-stub.log");

  await mkdir(join(rootDir, "scripts", "docker"), { recursive: true });
  await mkdir(join(rootDir, "scripts", "lib"), { recursive: true });
  await copyFile(join(repoRoot, "scripts", "docker", "setup.sh"), scriptPath);
  for (const file of [
    "docker-build.sh",
    "build-metadata.sh",
    "docker-e2e-logs.sh",
    "docker-e2e-container.sh",
    "docker-e2e-watchdog.mjs",
    "docker-e2e-resource-diagnostics.sh",
    "host-timeout.sh",
  ]) {
    await copyFile(join(repoRoot, "scripts", "lib", file), join(rootDir, "scripts", "lib", file));
  }
  await writeFile(join(rootDir, "Dockerfile"), "FROM scratch\n");
  await writeFile(
    join(rootDir, "docker-compose.yml"),
    "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
  );
  await writeDockerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

export const prestartContainerEnvFlags = [
  "-e HOME=/home/node",
  "-e OPENCLAW_HOME=/home/node",
  "-e OPENCLAW_STATE_DIR=/home/node/.openclaw",
  "-e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json",
  "-e OPENCLAW_CONFIG_DIR=/home/node/.openclaw",
  "-e OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace",
].join(" ");

export const noFollowOwnershipRepair = (root: string) =>
  `/usr/bin/find -P ${root} -xdev -execdir /usr/bin/chown -h node:node {} +`;
export const prestartSafePath = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const resetDockerLog = (sandbox: DockerSetupSandbox) => writeFile(sandbox.logPath, "");
export const readDockerLog = (sandbox: DockerSetupSandbox) => readFile(sandbox.logPath, "utf8");
export const isGatewayStartLine = (line: string) =>
  line.includes("compose") && line.includes(" up -d") && line.includes("openclaw-gateway");

export function expectOfflineComposePolicy(
  lines: string[],
  options: { gatewayStarts?: boolean } = {},
) {
  const composeLines = lines.filter((line) => line.startsWith("compose "));
  expect(composeLines.length).toBeGreaterThan(0);
  for (const line of composeLines) {
    if (line.includes(" run ")) {
      expect(line).toContain(" run --pull never ");
    }
  }
  const gatewayStarts = composeLines.filter(isGatewayStartLine);
  expect(gatewayStarts.length > 0).toBe(options.gatewayStarts !== false);
  for (const line of gatewayStarts) {
    expect(line).toContain(" up -d --pull never --no-build");
  }
}

export async function withUnixSocket<T>(socketPath: string, run: () => Promise<T>): Promise<T> {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen(socketPath);
  await listening;

  try {
    return await run();
  } finally {
    await new Promise<void>((resolveLocal) => {
      server.close(() => resolveLocal());
    });
    await rm(socketPath, { force: true });
  }
}

export function resolveBashForCompatCheck(): string | null {
  for (const candidate of ["/bin/bash", "bash"]) {
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}
