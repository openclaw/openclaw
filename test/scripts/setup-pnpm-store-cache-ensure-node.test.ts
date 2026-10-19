import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const ensureNodeScript = resolve(".github/actions/setup-pnpm-store-cache/ensure-node.sh");
const temps = useAutoCleanupTempDirTracker(afterEach);

function runShell(lines: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("bash", ["-c", lines.join("\n")], { encoding: "utf8", env });
}

function runDownload(root: string, lines: string[], env: NodeJS.ProcessEnv = {}, strict = true) {
  const helperBin = join(root, "bin");
  writeFakeCurl(helperBin);
  return runShell(
    [strict ? "set -euo pipefail" : "set -uo pipefail", `source "${ensureNodeScript}"`, ...lines],
    {
      ...process.env,
      PATH: `${helperBin}:${process.env.PATH ?? ""}`,
      OPENCLAW_FAKE_CURL_LOG: join(root, "curl.log"),
      ...env,
    },
  );
}

function writeExecutable(binDir: string, name: string, body: string) {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return file;
}

function writeFakeNode(binDir: string, version: string) {
  return writeExecutable(
    binDir,
    "node",
    `if [[ "$1" == "-p" ]]; then
  echo "${version}"
  exit 0
fi
if [[ "$1" == "-v" ]]; then
  echo "v${version}"
  exit 0
fi
exit 0
`,
  );
}

function writeFakeCurl(binDir: string) {
  writeExecutable(
    binDir,
    "curl",
    `set -euo pipefail
printf '%s\\n' "$*" >> "$OPENCLAW_FAKE_CURL_LOG"
output=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    http://* | https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [[ -n "\${OPENCLAW_FAKE_CURL_FAIL_SUFFIX:-}" && "$url" == *"\${OPENCLAW_FAKE_CURL_FAIL_SUFFIX:-}" ]]; then
  if [[ -n "$output" ]]; then
    printf '%s' 'partial archive' > "$output"
  fi
  exit 28
fi
if [[ "$url" == */index.json ]]; then
  printf '%s\\n' '[{"version":"v24.16.0"}]'
elif [[ -n "$output" ]]; then
  : > "$output"
else
  printf '%s' 'archive'
fi
`,
  );
}

function runEnsureNode(root: string, requested: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return runShell(
    [
      "set -e",
      ...(extraEnv.PATH ? [`export PATH=${JSON.stringify(extraEnv.PATH)}`] : []),
      `source "${ensureNodeScript}"`,
      `openclaw_ensure_node "${requested}"`,
      "command -v node",
      "node -p 'process.versions.node'",
    ],
    {
      ...process.env,
      GITHUB_PATH: join(root, "github-path"),
      ...extraEnv,
    },
  );
}

function runVersionMatch(actual: string, requested: string) {
  return runShell([
    `source "${ensureNodeScript}"`,
    `openclaw_node_version_matches "${actual}" "${requested}"`,
  ]);
}

describe("setup-pnpm-store-cache ensure-node", () => {
  it("handles missing toolcache roots under nounset", () => {
    const root = temps.make("openclaw-ensure-node-");
    const result = runShell(
      [
        "set -euo pipefail",
        `source "${ensureNodeScript}"`,
        `openclaw_find_toolcache_node "99.99.99"`,
      ],
      {
        PATH: process.env.PATH ?? "",
        RUNNER_TOOL_CACHE: join(root, "missing-toolcache"),
        AGENT_TOOLSDIRECTORY: join(root, "missing-agent-tools"),
        ACTIONS_RUNNER_TOOL_CACHE: join(root, "missing-actions-cache"),
        OPENCLAW_CONTAINER_TOOL_CACHE: join(root, "missing-container-cache"),
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("unbound variable");
  });

  it("normalizes Windows toolcache paths for Git Bash before prepending PATH", () => {
    const root = temps.make("openclaw-ensure-node-");
    const activeBin = join(root, "active", "bin");
    writeFakeNode(activeBin, "22.22.3");
    const toolcacheBin = join(root, "toolcache", "node", "24.16.0", "x64");
    const toolcacheNode = writeFakeNode(toolcacheBin, "24.16.0");
    const helperBin = join(root, "helpers");
    writeExecutable(
      helperBin,
      "cygpath",
      `if [[ "$1" == "-u" ]]; then
  echo "${toolcacheBin}"
  exit 0
fi
if [[ "$1" == "-w" ]]; then
  echo "C:\\\\hostedtoolcache\\\\windows\\\\node\\\\24.16.0\\\\x64"
  exit 0
fi
exit 1
`,
    );
    const githubPath = join(root, "github-path");
    const result = runShell([
      "set -e",
      `export PATH=${JSON.stringify(`${helperBin}:${activeBin}:${process.env.PATH ?? ""}`)}`,
      `export GITHUB_PATH=${JSON.stringify(githubPath)}`,
      `source "${ensureNodeScript}"`,
      `openclaw_prepend_node_bin "C:\\\\hostedtoolcache\\\\windows/node/24.16.0/x64"`,
      "command -v node",
      "node -p 'process.versions.node'",
      `cat "${githubPath}"`,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${toolcacheNode}\n24.16.0`);
    expect(result.stdout).toContain("C:\\hostedtoolcache\\windows\\node\\24.16.0\\x64");
  });

  it("repairs PATH from the container-mounted GitHub Actions toolcache", () => {
    const root = temps.make("openclaw-ensure-node-");
    const activeBin = join(root, "active", "bin");
    writeFakeNode(activeBin, "20.20.0");
    const toolcacheBin = join(root, "__t", "node", "24.99.99", "x64", "bin");
    const toolcacheNode = writeFakeNode(toolcacheBin, "24.99.99");
    const result = runEnsureNode(root, "24.99.99", {
      PATH: `${activeBin}:${process.env.PATH ?? ""}`,
      OPENCLAW_CONTAINER_TOOL_CACHE: join(root, "__t"),
      RUNNER_TOOL_CACHE: join(root, "hostedtoolcache"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Using Node 24.99.99 from ${toolcacheNode}`);
    expect(result.stdout).toContain(`${toolcacheNode}\n24.99.99`);
  });

  it("prefers the repo-owned cached toolchain over an image toolcache below the floor", () => {
    // Image Node versions are below the floor; use the repo cache instead of downloading.
    const root = temps.make("openclaw-ensure-node-");
    const activeBin = join(root, "active", "bin");
    writeFakeNode(activeBin, "20.20.0");
    writeFakeNode(join(root, "toolcache", "node", "24.13.0", "x64", "bin"), "24.13.0");
    const cachedBin = join(root, "cached", "node", "v24.19.0-linux-x64", "bin");
    const cachedNode = writeFakeNode(cachedBin, "24.19.0");
    const result = runEnsureNode(root, "24.x", {
      PATH: `${activeBin}:${process.env.PATH ?? ""}`,
      RUNNER_TOOL_CACHE: join(root, "toolcache"),
      OPENCLAW_NODE_TOOLCHAIN_ROOT: join(root, "cached", "node"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Using Node 24.19.0 from ${cachedNode}`);
    expect(result.stdout).not.toContain("Downloading Node");
    expect(result.stdout.trim().endsWith("24.19.0")).toBe(true);
  });

  it("enforces patched Node 24 and 26 wildcard minimums", () => {
    expect(runVersionMatch("24.14.1", "24.x").status).toBe(1);
    expect(runVersionMatch("24.16.0", "24.x").status).toBe(0);
    expect(runVersionMatch("26.0.0", "26.x").status).toBe(1);
    expect(runVersionMatch("26.1.0", "26.x").status).toBe(0);
  });

  it("replaces a rejected payload in the cached toolchain root instead of accreting", () => {
    // Rejected installs must not accumulate in the cache saved wholesale.
    const root = temps.make("openclaw-ensure-node-");
    const toolchainRoot = join(root, "toolchain", "node");
    writeFakeNode(join(toolchainRoot, "v24.13.0-linux-x64", "bin"), "24.13.0");
    const result = runDownload(
      root,
      [
        "openclaw_prepend_node_bin() { :; }",
        'openclaw_node_download_platform() { printf "linux-x64\\n"; }',
        "tar() { :; }",
        `RUNNER_TEMP=${JSON.stringify(root)} openclaw_download_node "24.16.0"`,
      ],
      { OPENCLAW_NODE_TOOLCHAIN_ROOT: toolchainRoot },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(toolchainRoot, "v24.13.0-linux-x64"))).toBe(false);
    expect(existsSync(join(toolchainRoot, "v24.16.0-linux-x64"))).toBe(true);
  });

  it("bounds every Node distribution request", () => {
    const root = temps.make("openclaw-ensure-node-");
    const curlLog = join(root, "curl.log");
    const result = runDownload(root, [
      'openclaw_resolve_node_download_version "24.x"',
      "openclaw_prepend_node_bin() { :; }",
      'openclaw_node_download_platform() { printf "win-x64\\n"; }',
      "pwsh() { :; }",
      `RUNNER_TEMP=${JSON.stringify(root)} openclaw_download_node "24.16.0"`,
      'openclaw_node_download_platform() { printf "linux-x64\\n"; }',
      "tar() { :; }",
      `RUNNER_TEMP=${JSON.stringify(root)} openclaw_download_node "24.16.0"`,
    ]);

    expect(result.status, result.stderr).toBe(0);
    const curlCalls = readFileSync(curlLog, "utf8").trim().split("\n");
    expect(curlCalls).toHaveLength(3);
    for (const call of curlCalls) {
      expect(call).toContain(
        "-fSL --no-progress-meter --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2",
      );
    }
    expect(curlCalls[0]).toContain("https://nodejs.org/dist/index.json");
    expect(curlCalls[1]).toContain("https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip");
    expect(curlCalls[2]).toContain(
      "https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz",
    );
    expect(existsSync(join(root, "node-v24.16.0-linux-x64.tar.xz"))).toBe(false);
  });

  it("removes a partial POSIX archive after a timed-out download", () => {
    const root = temps.make("openclaw-ensure-node-");
    const result = runDownload(
      root,
      [
        "openclaw_prepend_node_bin() { :; }",
        'openclaw_node_download_platform() { printf "linux-x64\\n"; }',
        `RUNNER_TEMP=${JSON.stringify(root)} openclaw_download_node "24.16.0"`,
      ],
      { OPENCLAW_FAKE_CURL_FAIL_SUFFIX: ".tar.xz" },
      false,
    );

    expect(result.status).toBe(1);
    expect(existsSync(join(root, "node-v24.16.0-linux-x64.tar.xz"))).toBe(false);
  });
});
