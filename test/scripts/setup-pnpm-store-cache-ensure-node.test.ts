import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowCondition,
  evaluateWorkflowExpression,
  readWorkflowOutputs,
  requiredWorkflowStep,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const ensureNodeScript = resolve(".github/actions/setup-pnpm-store-cache/ensure-node.sh");
const temps = useAutoCleanupTempDirTracker(afterEach);

function runShell(lines: string[], env: NodeJS.ProcessEnv = process.env) {
  const setup = lines[0]?.startsWith("set ") ? lines.slice(0, 1) : [];
  const script = [...setup, `source "${ensureNodeScript}"`, ...lines.slice(setup.length)];
  return spawnSync("bash", ["-c", script.join("\n")], {
    encoding: "utf8",
    env,
  });
}

function runDownload(root: string, lines: string[], env: NodeJS.ProcessEnv = {}, strict = true) {
  const helperBin = join(root, "bin");
  writeFakeCurl(helperBin);
  return runShell([strict ? "set -euo pipefail" : "set -uo pipefail", ...lines], {
    ...process.env,
    PATH: `${helperBin}:${process.env.PATH ?? ""}`,
    OPENCLAW_FAKE_CURL_LOG: join(root, "curl.log"),
    ...env,
  });
}

const archiveSetup = (platform: string, extract = true) => [
  "openclaw_prepend_node_bin() { :; }",
  `openclaw_node_download_platform() { printf '${platform}\\n'; }`,
  ...(extract ? [platform === "win-x64" ? "pwsh() { :; }" : "tar() { :; }"] : []),
];
const download = (root: string) =>
  `RUNNER_TEMP=${JSON.stringify(root)} openclaw_download_node "24.22.1"`;

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
    `case "$1" in
  -p) echo "${version}" ;;
  -v) echo "v${version}" ;;
esac`,
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
    -o) output="$2"; shift 2 ;;
    http://* | https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ -n "\${OPENCLAW_FAKE_CURL_FAIL_SUFFIX:-}" && "$url" == *"\${OPENCLAW_FAKE_CURL_FAIL_SUFFIX:-}" ]]; then
  if [[ -n "$output" ]]; then
    printf '%s' 'partial archive' > "$output"
  fi
  exit 28
fi
if [[ "$url" == */index.json ]]; then
  printf '%s\\n' '[{"version":"v24.22.1"}]'
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

describe("setup-pnpm-store-cache ensure-node", () => {
  it.each([
    {
      local: "24.99.99",
      restored: "",
      downloaded: "24.99.99",
      restores: 0,
      downloads: 0,
      status: 0,
    },
    {
      local: "",
      toolcache: "24.99.99",
      restored: "",
      downloaded: "",
      restores: 0,
      downloads: 0,
      status: 0,
    },
    {
      local: "24.13.0",
      toolcache: "24.99.99",
      restored: "",
      downloaded: "",
      restores: 0,
      downloads: 0,
      status: 0,
    },
    {
      local: "",
      restored: "24.99.99",
      downloaded: "24.99.99",
      restores: 1,
      downloads: 0,
      status: 0,
    },
    {
      local: "24.13.0",
      restored: "24.99.99",
      downloaded: "24.99.99",
      restores: 1,
      downloads: 0,
      status: 0,
    },
    {
      local: "",
      restored: "24.13.0",
      downloaded: "24.99.99",
      restores: 1,
      downloads: 1,
      status: 0,
    },
    { local: "", restored: "24.13.0", downloaded: "24.13.0", restores: 1, downloads: 1, status: 1 },
    {
      local: "24.99.99",
      restored: "",
      downloaded: "",
      restores: 0,
      downloads: 0,
      status: 0,
      cacheMode: "off",
    },
    {
      local: "24.99.99",
      restored: "",
      downloaded: "",
      restores: 0,
      downloads: 0,
      status: 0,
      runnerOs: "Windows",
    },
    {
      local: "24.99.99",
      restored: "",
      downloaded: "",
      restores: 0,
      downloads: 0,
      status: 0,
      runnerEnvironment: "github-hosted",
    },
  ])("runs the shipped local/restore/download flow: %j", (scenario) => {
    const root = temps.make("openclaw-node-action-");
    const steps = (
      parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8")) as {
        runs: { steps: WorkflowStep[] };
      }
    ).runs.steps;
    const normalize = requiredWorkflowStep(steps, "Normalize container toolcache");
    const restore = requiredWorkflowStep(steps, "Restore Node toolchain cache");
    const setup = requiredWorkflowStep(steps, "Setup Node.js");
    expect(steps.indexOf(normalize)).toBeLessThan(steps.indexOf(restore));
    expect(steps.indexOf(restore)).toBeLessThan(steps.indexOf(setup));
    const bin = join(root, "bin");
    const runnerToolcache = join(root, "toolcache");
    const toolcacheBin = join(runnerToolcache, "node", "24.99.99", "x64", "bin");
    if (scenario.toolcache) {
      writeFakeNode(toolcacheBin, scenario.toolcache);
    }
    const toolchain = join(root, "openclaw-node-toolchain", "node");
    if (scenario.local) {
      const node = writeFakeNode(bin, scenario.local);
      writeFileSync(
        node,
        readFileSync(node, "utf8").replace(
          'case "$1"',
          `echo probe >> "${join(root, "probes")}"\ncase "$1"`,
        ),
      );
    } else {
      writeExecutable(bin, "node", "exit 127");
    }
    const downloadedNode = writeFakeNode(join(root, "download"), scenario.downloaded);
    writeFakeCurl(bin);
    writeExecutable(bin, "tar", `mkdir -p "$4/bin"\ncp "${downloadedNode}" "$4/bin/node"`);
    const githubPath = join(root, "github-path");
    const output = join(root, "output");
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      RUNNER_TEMP: root,
      RUNNER_TOOL_CACHE: runnerToolcache,
      OPENCLAW_CONTAINER_TOOL_CACHE: join(root, "missing"),
      GITHUB_ACTION_PATH: resolve(".github/actions/setup-node-env"),
      GITHUB_PATH: githubPath,
      GITHUB_OUTPUT: output,
      OPENCLAW_FAKE_CURL_LOG: join(root, "curl.log"),
    };
    const context = {
      eventName: "pull_request" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerEnvironment:
        scenario.runnerEnvironment === "github-hosted"
          ? ("github-hosted" as const)
          : ("self-hosted" as const),
      runnerOs: scenario.runnerOs === "Windows" ? ("Windows" as const) : ("Linux" as const),
      runnerTemp: root,
      inputs: { "node-version": "24.99.99", "cache-mode": scenario.cacheMode ?? "restore" },
      env: { NODE_VERSION: "" },
    };
    function runStep(step: WorkflowStep) {
      writeFileSync(output, "");
      const stepEnv = Object.fromEntries(
        Object.entries(step.env ?? {}).map(([key, value]) => [
          key,
          String(evaluateWorkflowExpression(value, context)),
        ]),
      );
      return spawnSync("/bin/bash", ["-c", step.run!], {
        encoding: "utf8",
        env: { ...env, ...stepEnv },
        timeout: 10_000,
      });
    }
    const preflight = runStep(normalize);
    expect(preflight.status, preflight.stderr).toBe(0);
    if (scenario.cacheMode || scenario.runnerOs || scenario.runnerEnvironment) {
      expect(existsSync(join(root, "probes"))).toBe(false);
    }
    if (existsSync(githubPath)) {
      env.PATH = `${readFileSync(githubPath, "utf8").trim().split("\n").toReversed().join(":")}:${env.PATH}`;
    }
    if (scenario.toolcache) {
      expect(readFileSync(githubPath, "utf8").trim()).toBe(toolcacheBin);
    }
    const shouldRestore = evaluateWorkflowCondition(restore.if ?? "true", {
      ...context,
      steps: { [normalize.id ?? "local-node"]: { outputs: readWorkflowOutputs(output) } },
    });
    expect(Number(shouldRestore)).toBe(scenario.restores);
    if (shouldRestore && scenario.restored) {
      writeFakeNode(join(toolchain, "restored", "bin"), scenario.restored);
    }
    const result = runStep(setup);
    expect(result.status, result.stderr).toBe(scenario.status);
    const calls = existsSync(env.OPENCLAW_FAKE_CURL_LOG)
      ? readFileSync(env.OPENCLAW_FAKE_CURL_LOG, "utf8").trim().split("\n")
      : [];
    expect(calls).toHaveLength(scenario.downloads);
    if (scenario.status === 0) {
      expect(readWorkflowOutputs(output)["resolved-version"]).toBe("24.99.99");
    } else {
      expect(result.stdout).toContain("::error::Expected Node");
    }
  });

  it("handles missing toolcache roots under nounset", () => {
    const root = temps.make("openclaw-ensure-node-");
    const result = runShell(["set -euo pipefail", `openclaw_find_toolcache_node "99.99.99"`], {
      PATH: process.env.PATH ?? "",
      RUNNER_TOOL_CACHE: join(root, "missing-toolcache"),
      AGENT_TOOLSDIRECTORY: join(root, "missing-agent-tools"),
      ACTIONS_RUNNER_TOOL_CACHE: join(root, "missing-actions-cache"),
      OPENCLAW_CONTAINER_TOOL_CACHE: join(root, "missing-container-cache"),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("unbound variable");
  });

  it("normalizes Windows toolcache paths for Git Bash before prepending PATH", () => {
    const root = temps.make("openclaw-ensure-node-");
    const activeBin = join(root, "active", "bin");
    writeFakeNode(activeBin, "22.22.3");
    const toolcacheBin = join(root, "toolcache", "node", "24.22.1", "x64");
    const toolcacheNode = writeFakeNode(toolcacheBin, "24.22.1");
    const helperBin = join(root, "helpers");
    writeExecutable(
      helperBin,
      "cygpath",
      `case "$1" in
  -u) echo "${toolcacheBin}" ;;
  -w) echo "C:\\\\hostedtoolcache\\\\windows\\\\node\\\\24.22.1\\\\x64" ;;
  *) exit 1 ;;
esac`,
    );
    const githubPath = join(root, "github-path");
    const result = runShell([
      "set -e",
      `export PATH=${JSON.stringify(`${helperBin}:${activeBin}:${process.env.PATH ?? ""}`)}`,
      `export GITHUB_PATH=${JSON.stringify(githubPath)}`,
      `openclaw_prepend_node_bin "C:\\\\hostedtoolcache\\\\windows/node/24.22.1/x64"`,
      "command -v node",
      "node -p 'process.versions.node'",
      `cat "${githubPath}"`,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${toolcacheNode}\n24.22.1`);
    expect(result.stdout).toContain("C:\\hostedtoolcache\\windows\\node\\24.22.1\\x64");
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
    const root = temps.make("openclaw-ensure-node-");
    const activeBin = join(root, "active", "bin");
    writeFakeNode(activeBin, "20.20.0");
    writeFakeNode(join(root, "toolcache", "node", "24.13.0", "x64", "bin"), "24.13.0");
    const cachedBin = join(root, "cached", "node", "v24.22.1-linux-x64", "bin");
    const cachedNode = writeFakeNode(cachedBin, "24.22.1");
    const result = runEnsureNode(root, "24.x", {
      PATH: `${activeBin}:${process.env.PATH ?? ""}`,
      RUNNER_TOOL_CACHE: join(root, "toolcache"),
      OPENCLAW_NODE_TOOLCHAIN_ROOT: join(root, "cached", "node"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Using Node 24.22.1 from ${cachedNode}`);
    expect(result.stdout).not.toContain("Downloading Node");
    expect(result.stdout.trim().endsWith("24.22.1")).toBe(true);
  });

  it("enforces patched Node 24 and 26 wildcard minimums", () => {
    const match = (actual: string, requested: string) =>
      runShell([`openclaw_node_version_matches "${actual}" "${requested}"`]).status;
    expect(match("24.14.1", "24.x")).toBe(1);
    expect(match("24.22.0", "24.x")).toBe(1);
    expect(match("24.22.1", "24.x")).toBe(0);
    expect(match("26.0.0", "26.x")).toBe(1);
    expect(match("26.12.0", "26.x")).toBe(1);
    expect(match("26.12.1", "26.x")).toBe(0);
  });

  it("replaces a rejected payload in the cached toolchain root instead of accreting", () => {
    const root = temps.make("openclaw-ensure-node-");
    const toolchainRoot = join(root, "toolchain", "node");
    writeFakeNode(join(toolchainRoot, "v24.13.0-linux-x64", "bin"), "24.13.0");
    const result = runDownload(root, [...archiveSetup("linux-x64"), download(root)], {
      OPENCLAW_NODE_TOOLCHAIN_ROOT: toolchainRoot,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(toolchainRoot, "v24.13.0-linux-x64"))).toBe(false);
    expect(existsSync(join(toolchainRoot, "v24.22.1-linux-x64"))).toBe(true);
  });

  it("bounds every Node distribution request", () => {
    const root = temps.make("openclaw-ensure-node-");
    const curlLog = join(root, "curl.log");
    const result = runDownload(root, [
      'openclaw_resolve_node_download_version "24.x"',
      ...archiveSetup("win-x64"),
      download(root),
      ...archiveSetup("linux-x64"),
      download(root),
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
    expect(curlCalls[1]).toContain("https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip");
    expect(curlCalls[2]).toContain(
      "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz",
    );
    expect(existsSync(join(root, "node-v24.22.1-linux-x64.tar.xz"))).toBe(false);
  });

  it("removes a partial POSIX archive after a timed-out download", () => {
    const root = temps.make("openclaw-ensure-node-");
    const result = runDownload(
      root,
      [...archiveSetup("linux-x64", false), download(root)],
      { OPENCLAW_FAKE_CURL_FAIL_SUFFIX: ".tar.xz" },
      false,
    );

    expect(result.status).toBe(1);
    expect(existsSync(join(root, "node-v24.22.1-linux-x64.tar.xz"))).toBe(false);
  });
});
