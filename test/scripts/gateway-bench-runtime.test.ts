import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as bench from "../../scripts/lib/gateway-bench-runtime.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { startGatewayDiscovery } from "../../src/gateway/server-discovery-runtime.js";
import {
  resolveWideAreaDiscoveryDomain,
  writeWideAreaGatewayZone,
} from "../../src/infra/widearea-dns.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../src/infra/widearea-dns.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/infra/widearea-dns.js")>();
  return {
    ...actual,
    resolveWideAreaDiscoveryDomain: vi.fn(actual.resolveWideAreaDiscoveryDomain),
    writeWideAreaGatewayZone: vi.fn(async () => ({ changed: false, zonePath: "unused" })),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([undefined, true, false])(
  "activates benchmark plugins unless startup activation is disabled (%s)",
  (activationOnStartup) => {
    const root = tempDirs.make("gateway-plugin-load-");
    const fixtures = bench.writePluginFixtures(root, { count: 2, activationOnStartup });
    expect(fixtures.pluginIds).toHaveLength(2);
    for (const id of fixtures.pluginIds) {
      expect(loadPluginManifest(path.join(fixtures.pluginsDir, id))).toMatchObject({
        ok: true,
        manifest: { id, activation: { onStartup: activationOnStartup !== false } },
      });
    }
  },
);

it.each([undefined, "0,1,2,3"])(
  "keeps the selected executable and Gateway arguments together with affinity %s",
  (gatewayCpus) => {
    const gatewayRuntime = "/tmp/runtime with spaces/bun";
    const flags = new Map([["--gateway-runtime", [gatewayRuntime]]]);
    if (gatewayCpus) {
      flags.set("--gateway-cpus", [gatewayCpus]);
    }
    const args = bench.buildGatewayBenchChildArgs("dist/entry.js", 18789, ["--import", "probe.ts"]);
    const options = bench.parseGatewayBenchRuntimeOptions(flags);
    expect(bench.buildGatewayBenchCommand(args, options, "linux")).toEqual({
      command: gatewayCpus ? "taskset" : gatewayRuntime,
      args: gatewayCpus ? ["--cpu-list", gatewayCpus, gatewayRuntime, ...args] : args,
    });
    expect(args.slice(0, 3)).toEqual(["--import", "probe.ts", "dist/entry.js"]);
  },
);

it.each(["", " --inspect", "bun\0other"])("rejects invalid executable %j", (value) => {
  expect(() =>
    bench.parseGatewayBenchRuntimeOptions(new Map([["--gateway-runtime", [value]]])),
  ).toThrow("--gateway-runtime");
});

it("rejects a CPU list with trailing whitespace", () => {
  expect(() =>
    bench.parseGatewayBenchRuntimeOptions(new Map([["--gateway-cpus", ["0,1 "]]])),
  ).toThrow("--gateway-cpus requires comma-separated CPU numbers");
});

it("rejects affinity on Windows before spawn", () => {
  const options = { gatewayRuntime: "bun", gatewayCpus: "0,1" };
  expect(() => bench.buildGatewayBenchCommand(["entry.js"], options, "win32")).toThrow(
    "--gateway-cpus requires Linux taskset",
  );
});
const stats = { p50: 1.5, avg: 1.5, min: 1, max: 2, p95: 2 };
it.each([
  [undefined, "p50=1.5ms avg=1.5ms min=1.0ms max=2.0ms"],
  [bench.formatMb, "p50=1.5MB avg=1.5MB min=1.0MB max=2.0MB"],
] as const)("formats statistics with %s", (format, expected) => {
  expect(bench.formatStats(stats, format)).toBe(expected);
});

it("keeps missing statistics unavailable", () => {
  const format = vi.fn(() => "unexpected");
  expect(bench.formatStats(null, format)).toBe("n/a");
  expect(format).not.toHaveBeenCalled();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([false, true])("publishes discovery only when enabled=%s", async (enabled) => {
  const root = tempDirs.make("openclaw-bench-discovery-");
  const configPath = bench.writeGatewayBenchConfig(
    root,
    enabled
      ? { ...bench.BASE_GATEWAY_BENCH_CONFIG, discovery: { mdns: { mode: "minimal" } } }
      : bench.BASE_GATEWAY_BENCH_CONFIG,
    {},
  );
  vi.stubEnv("OPENCLAW_WIDE_AREA_DOMAIN", "inherited.example.test");
  const childEnv = bench.createGatewayBenchEnv(root, configPath, {});
  const envKeys = `HOME OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH NODE_ENV VITEST
      OPENCLAW_DISABLE_BONJOUR OPENCLAW_WIDE_AREA_DOMAIN OPENCLAW_TAILNET_DNS
      OPENCLAW_CLI_PATH OPENCLAW_SSH_PORT OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS`;
  for (const key of envKeys.split(/\s+/u)) {
    vi.stubEnv(key, childEnv[key]);
  }
  const cfgAtStart: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const stop = vi.fn();
  const advertise = vi.fn(async () => ({ stop }));
  const id = "fixture-discovery";
  const discovery = await startGatewayDiscovery({
    machineDisplayName: "Benchmark fixture",
    discovery: cfgAtStart.discovery,
    port: 18789,
    gatewayTls: { enabled: false },
    gatewayDirectReachable: false,
    tailscaleMode: "off",
    logDiscovery: { info: vi.fn(), warn: vi.fn() },
    gatewayDiscoveryServices: [{ pluginId: id, source: "test", id, service: { id, advertise } }],
  });
  await discovery.stop();

  expect(childEnv.OPENCLAW_WIDE_AREA_DOMAIN).toBeUndefined();
  expect(resolveWideAreaDiscoveryDomain).not.toHaveBeenCalled();
  expect(writeWideAreaGatewayZone).not.toHaveBeenCalled();
  if (enabled) {
    expect(advertise).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ gatewayDirectReachable: false, minimal: true }),
    );
    expect(stop).toHaveBeenCalledOnce();
  } else {
    expect(advertise).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  }
});
