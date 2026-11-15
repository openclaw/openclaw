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
  expect(sliceStart).toBeGreaterThanOrEqual(0);
  expect(sliceEndMarkerIndex).toBeGreaterThan(sliceStart);

  const fixtureRoot = tempDirs.make("openclaw-performance-isolation-");
  const binDir = join(fixtureRoot, "bin");
  mkdirSync(binDir);
  const shim = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const env = process.env, args = process.argv.slice(2), command = path.basename(process.argv[1]);
const capture = (file, value) => fs.writeFileSync(path.join(env.CAPTURE_DIR, file), value);
const event = (name) => fs.appendFileSync(env.EVENTS_FILE, name + "\\n");
if (command === "node" && args[0] === "-e") {
  process.exit(spawnSync(env.REAL_NODE, args, { stdio: "inherit" }).status ?? 64);
} else if (command === "node") {
  const name = args[2] === "run" ? "gateway" : args[2] === "health" ? "health" : "benchmark";
  assert((args[0] === "dist/entry.js" && args[1] === "gateway" && ["run", "health"].includes(args[2])) ||
    (args[0] === "--import" && args[1] === "tsx" && args[2].endsWith("bench-cli-startup.ts")));
  const keys = ["HOME", "STATE_DIR", "CONFIG_PATH", "GATEWAY_PORT", "GATEWAY_TOKEN", "SKIP_CHANNELS", "SKIP_CRON"];
  capture(name + ".env", JSON.stringify(Object.fromEntries(keys.map(key => [
    "OPENCLAW_" + key, env["OPENCLAW_" + key] ?? "<unset>"
  ]))));
  capture(name + ".argv", args.join("\\n") + "\\n");
  capture(name + ".config", fs.readFileSync(env.OPENCLAW_CONFIG_PATH));
  event(name === "gateway" ? "gateway-run" : name === "health" ? "gateway-health" : name);
  if (name === "gateway") {
    capture("gateway.port", env.OPENCLAW_GATEWAY_PORT);
    capture("gateway.ready", "");
    process.on("SIGTERM", () => { capture("gateway.terminated", "terminated\\n"); process.exit(0); });
    process.on("SIGINT", () => { capture("gateway.terminated", "terminated\\n"); process.exit(0); });
    setTimeout(() => process.exit(64), 8000);
  }
} else if (command === "cp") {
  assert.equal(args.length, 2);
  assert(!fs.existsSync(path.join(env.CAPTURE_DIR, "readiness-copy.config")));
  capture("readiness-copy.config", fs.readFileSync(args[0]));
  fs.copyFileSync(args[0], args[1]);
} else if (command === "curl") {
  const port = fs.readFileSync(path.join(env.CAPTURE_DIR, "gateway.port"), "utf8").trim();
  assert(args.includes("http://127.0.0.1:" + port + "/healthz"));
  assert(fs.existsSync(path.join(env.CAPTURE_DIR, "gateway.ready")));
  event("http-health");
} else {
  assert.deepEqual(args.slice(0, 1), ["-q"]);
  assert.equal(args.length, 3);
  const catalog = args[1] === "catalogRefresh:";
  assert.deepEqual(args.slice(1), catalog ? ["catalogRefresh:", "src/config/zod-schema.core.ts"] :
    ["heartbeat:", "src/config/zod-schema.agent-defaults.ts"]);
  event(catalog ? "catalog-probe" : "heartbeat-probe");
  process.exit(Number(env[catalog ? "CATALOG_RG_STATUS" : "HEARTBEAT_RG_STATUS"]));
}
`;
  for (const command of ["node", "cp", "curl", "rg"]) {
    writeFileSync(join(binDir, command), shim, { mode: 0o755 });
  }

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
    expect(parsedConfig.gateway?.auth).toEqual({ mode: "token" });
    if (expectsCatalogRefresh) {
      expect(parsedConfig.models?.catalogRefresh?.enabled).toBe(false);
    } else {
      expect(parsedConfig.models?.catalogRefresh).toBeUndefined();
    }

    const readCapturedEnv = (name: string) =>
      JSON.parse(readCapture(`${name}.env`)) as Record<string, string>;
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

  expect(
    JSON.stringify([
      workflow.env,
      job?.env,
      step.env,
      run.slice(0, sliceStart),
      jobSteps.slice(0, targetStepIndex),
      run.split("\n").filter((line) => line.includes("GITHUB_ENV")),
    ]),
  ).not.toContain("OPENCLAW_SKIP_CRON");
});
