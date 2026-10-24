import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readPerformanceWorkflow } from "./openclaw-performance-workflow.test-support.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("isolates the source performance gateway from network and scheduled work", () => {
  const workflow = readPerformanceWorkflow();
  const job = workflow.jobs?.source_performance;
  const targetStepName = "Run OpenClaw source performance probes";
  const jobSteps = job?.steps ?? [];
  const targetStepIndex = jobSteps.findIndex((item) => item.name === targetStepName);
  const step = expectDefined(jobSteps[targetStepIndex], targetStepName);
  const run = step.run ?? "";
  const sliceStartMarker = 'gateway_home="$(mktemp -d)"';
  const sliceEndMarker = "cleanup_gateway\ntrap - EXIT";
  const sliceStart = run.indexOf(sliceStartMarker);
  const sliceEndMarkerIndex = run.indexOf(sliceEndMarker, sliceStart);
  const workflowSlice = run.slice(sliceStart, sliceEndMarkerIndex + sliceEndMarker.length);
  const cronEnv = "OPENCLAW_SKIP_CRON";
  expect(sliceStart).toBeGreaterThanOrEqual(0);
  expect(run.lastIndexOf(sliceStartMarker)).toBe(sliceStart);
  expect(sliceEndMarkerIndex).toBeGreaterThan(sliceStart);
  expect(run.lastIndexOf(sliceEndMarker)).toBe(sliceEndMarkerIndex);

  const fixtureRoot = tempDirs.make("openclaw-performance-isolation-");
  const binDir = join(fixtureRoot, "bin");
  mkdirSync(binDir);
  const writeCommand = (name: string, source: string) =>
    writeFileSync(join(binDir, name), `#!/bin/sh\nset -eu\n${source}`, { mode: 0o755 });
  writeCommand(
    "node",
    `capture() {
  name="$1"
  shift
  {
    printf 'OPENCLAW_HOME=%s\\n' "\${OPENCLAW_HOME-<unset>}"
    printf 'OPENCLAW_STATE_DIR=%s\\n' "\${OPENCLAW_STATE_DIR-<unset>}"
    printf 'OPENCLAW_CONFIG_PATH=%s\\n' "\${OPENCLAW_CONFIG_PATH-<unset>}"
    printf 'OPENCLAW_GATEWAY_PORT=%s\\n' "\${OPENCLAW_GATEWAY_PORT-<unset>}"
    printf 'OPENCLAW_GATEWAY_TOKEN=%s\\n' "\${OPENCLAW_GATEWAY_TOKEN-<unset>}"
    printf 'OPENCLAW_SKIP_CHANNELS=%s\\n' "\${OPENCLAW_SKIP_CHANNELS-<unset>}"
    printf 'OPENCLAW_SKIP_CRON=%s\\n' "\${OPENCLAW_SKIP_CRON-<unset>}"
  } > "$CAPTURE_DIR/$name.env"
  printf '%s\\n' "$@" > "$CAPTURE_DIR/$name.argv"
  /bin/cp "$OPENCLAW_CONFIG_PATH" "$CAPTURE_DIR/$name.config"
}
if [ "\${1-}" = "-e" ]; then
  [ -n "\${REAL_NODE-}" ] || { printf 'REAL_NODE is required\\n' >&2; exit 64; }
  exec "$REAL_NODE" "$@"
fi
case "\${1-}:\${2-}:\${3-}" in
  dist/entry.js:gateway:run) name=gateway; event=gateway-run ;;
  dist/entry.js:gateway:health) name=health; event=gateway-health ;;
  --import:tsx:*bench-cli-startup.ts) name=benchmark; event=benchmark ;;
  *) printf 'unexpected node argv: %s\\n' "$*" >&2; exit 64 ;;
esac
capture "$name" "$@"
if [ "$name" = gateway ]; then
  printf '%s\\n' "$OPENCLAW_GATEWAY_PORT" > "$CAPTURE_DIR/gateway.port"
  trap 'printf "terminated\\n" > "$CAPTURE_DIR/gateway.terminated"; exit 0' TERM INT
fi
printf '%s\\n' "$event" >> "$EVENTS_FILE"
[ "$name" = gateway ] || exit 0
: > "$CAPTURE_DIR/gateway.ready"
for _ in 1 2 3 4 5 6 7 8; do
  /bin/sleep 1
done
exit 64
`,
  );
  writeCommand(
    "cp",
    `[ "$#" -eq 2 ] || exit 64
[ ! -e "$CAPTURE_DIR/readiness-copy.config" ] || exit 64
/bin/cp "$1" "$CAPTURE_DIR/readiness-copy.config"
/bin/cp "$1" "$2"
`,
  );
  writeCommand(
    "curl",
    `[ -s "$CAPTURE_DIR/gateway.port" ] || exit 1
port="$(cat "$CAPTURE_DIR/gateway.port")"
expected="http://127.0.0.1:$port/healthz"
found=false
for arg in "$@"; do
  [ "$arg" = "$expected" ] && found=true
done
[ "$found" = true ] || { printf 'unexpected curl argv\\n' >&2; exit 64; }
[ -f "$CAPTURE_DIR/gateway.ready" ] || exit 1
printf 'http-health\\n' >> "$EVENTS_FILE"
`,
  );
  writeCommand(
    "rg",
    `[ "$#" -eq 3 ] && [ "$1" = '-q' ] || { printf 'unexpected rg argv\\n' >&2; exit 64; }
case "$2:$3" in
  catalogRefresh::src/config/zod-schema.core.ts) probe=catalog; status="$CATALOG_RG_STATUS" ;;
  heartbeat::src/config/zod-schema.agent-defaults.ts) probe=heartbeat; status="$HEARTBEAT_RG_STATUS" ;;
  *) printf 'unexpected rg argv\\n' >&2; exit 64 ;;
esac
printf '%s-probe\\n' "$probe" >> "$EVENTS_FILE"
exit "$status"
`,
  );

  // Older candidates lack catalogRefresh and still accept the retired heartbeat key.
  for (const [branch, expectsCatalogRefresh, expectsHeartbeat] of [
    ["older", false, true],
    ["current", true, false],
  ] as const) {
    const branchDir = join(fixtureRoot, branch);
    const captureDir = join(branchDir, "capture");
    const sourcePerfDir = join(branchDir, "source");
    const eventsFile = join(branchDir, "events.txt");
    const readCapture = (file: string) => readFileSync(join(captureDir, file), "utf8");
    mkdirSync(captureDir, { recursive: true });
    mkdirSync(sourcePerfDir);
    const isolatedEnv = { ...process.env };
    const ambientKeys = (
      "OPENCLAW_SKIP_CRON OPENCLAW_SKIP_CHANNELS OPENCLAW_GATEWAY_TOKEN " +
      "BASH_ENV ENV BASHOPTS SHELLOPTS CDPATH GLOBIGNORE PROMPT_COMMAND ZDOTDIR"
    ).split(" ");
    for (const name of ambientKeys) {
      delete isolatedEnv[name];
    }
    Object.assign(isolatedEnv, {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: branchDir,
      TMPDIR: branchDir,
      CAPTURE_DIR: captureDir,
      EVENTS_FILE: eventsFile,
      GITHUB_WORKSPACE: "/fixture/workspace",
      PERFORMANCE_HELPER_DIR: "/fixture/helpers",
      REAL_NODE: process.execPath,
      CATALOG_RG_STATUS: expectsCatalogRefresh ? "0" : "1",
      HEARTBEAT_RG_STATUS: expectsHeartbeat ? "0" : "1",
      SOURCE_PERF_DIR: sourcePerfDir,
      source_runs: "2",
    });
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-c", `set -euo pipefail\n${workflowSlice}`],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: isolatedEnv,
        timeout: 12_000,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);

    expect(readFileSync(eventsFile, "utf8").trim().split("\n")).toEqual([
      "catalog-probe",
      "heartbeat-probe",
      "gateway-run",
      "http-health",
      "gateway-health",
      "benchmark",
    ]);
    const gatewayConfig = readCapture("gateway.config");
    const gatewayPort = readCapture("gateway.port").trim();
    expect(gatewayPort).toMatch(/^[1-9][0-9]*$/);
    for (const name of ["readiness-copy", "health", "benchmark"]) {
      expect(readCapture(`${name}.config`)).toBe(gatewayConfig);
    }
    parse(gatewayConfig, { uniqueKeys: true });
    const parsedConfig = JSON.parse(gatewayConfig) as {
      gateway?: { auth?: Record<string, unknown> };
      agents?: unknown;
      models?: { catalogRefresh?: { enabled?: boolean } };
    };
    expect(parsedConfig.agents).toEqual(
      expectsHeartbeat ? { defaults: { heartbeat: { every: "0m" } } } : undefined,
    );
    expect(parsedConfig).toMatchObject({
      browser: { enabled: false },
      update: { checkOnStart: false },
      gateway: {
        mode: "local",
        port: Number(gatewayPort),
        bind: "loopback",
        controlUi: { enabled: false },
        tailscale: { mode: "off" },
      },
      plugins: { enabled: true, entries: { browser: { enabled: false } } },
    });
    expect(JSON.stringify(parsedConfig)).not.toContain('"dreaming":');
    expect(parsedConfig.gateway?.auth).toEqual({ mode: "token" });
    if (expectsCatalogRefresh) {
      expect(parsedConfig.models?.catalogRefresh?.enabled).toBe(false);
    } else {
      expect(parsedConfig.models?.catalogRefresh).toBeUndefined();
    }

    const readCapturedEnv = (name: string) =>
      Object.fromEntries(
        readCapture(`${name}.env`)
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      ) as Record<string, string>;
    const gatewayEnv = readCapturedEnv("gateway");
    const healthEnv = readCapturedEnv("health");
    const benchmarkEnv = readCapturedEnv("benchmark");
    const paths = (env: Record<string, string>) => {
      const home = expectDefined(env.OPENCLAW_HOME, "home capture");
      const state = expectDefined(env.OPENCLAW_STATE_DIR, "state capture");
      const config = expectDefined(env.OPENCLAW_CONFIG_PATH, "config capture");
      expect({ state, config }).toEqual({
        state: join(home, ".openclaw"),
        config: join(state, "openclaw.json"),
      });
      return { home, state, config };
    };
    const gatewayPaths = paths(gatewayEnv);
    const healthPaths = paths(healthEnv);
    expect(gatewayEnv).toMatchObject({
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_GATEWAY_PORT: gatewayPort,
    });
    const inherited = {
      OPENCLAW_SKIP_CRON: "<unset>",
      OPENCLAW_SKIP_CHANNELS: "<unset>",
      OPENCLAW_GATEWAY_TOKEN: gatewayEnv.OPENCLAW_GATEWAY_TOKEN,
    };
    expect(healthEnv).toMatchObject(inherited);
    expect(benchmarkEnv).toEqual({ ...gatewayEnv, ...inherited });
    expect(gatewayEnv.OPENCLAW_GATEWAY_TOKEN).toMatch(/^[0-9a-f]{64}$/u);
    for (const key of ["home", "state", "config"] as const) {
      expect(healthPaths[key]).not.toBe(gatewayPaths[key]);
    }

    expect(readCapture("gateway.argv").trim().split("\n")).toEqual(
      `dist/entry.js gateway run --bind loopback --port ${gatewayPort} --auth token --allow-unconfigured --force`.split(
        " ",
      ),
    );
    expect(readCapture("health.argv")).toContain(
      `dist/entry.js\ngateway\nhealth\n--port\n${gatewayPort}\n`,
    );
    expect(readCapture("benchmark.argv")).toContain(
      "--import\ntsx\n/fixture/helpers/scripts/bench-cli-startup.ts\n" +
        "--entry\n/fixture/workspace/openclaw.mjs\n" +
        "--case\ngatewayHealthJsonWarmState\n--case\ngatewayHealthJsonFreshState\n",
    );
    expect(readCapture("gateway.terminated")).toBe("terminated\n");
    expect([gatewayPaths.home, healthPaths.home].map(existsSync)).toEqual([false, false]);
  }

  expect(targetStepIndex).toBeGreaterThanOrEqual(0);
  const inheritedCronScopes = [
    ["workflow env", workflow.env],
    ["job env", job?.env],
    ["current step env", step.env],
    ["current step before harness", run.slice(0, sliceStart)],
    ["preceding steps", jobSteps.slice(0, targetStepIndex)],
    [
      "current step GITHUB_ENV writes",
      run
        .split("\n")
        .filter((line) => line.includes("GITHUB_ENV"))
        .join("\n"),
    ],
  ] as const;
  for (const [scope, value] of inheritedCronScopes) {
    expect(JSON.stringify(value ?? {}), scope).not.toContain(cronEnv);
  }
});
