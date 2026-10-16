import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  buildGatewayBenchCommand,
  createGatewayBenchEnv,
  formatMb,
  formatStats,
  parseGatewayBenchRuntimeOptions,
  writeGatewayBenchConfig,
} from "../../scripts/lib/gateway-bench-runtime.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { startGatewayDiscovery } from "../../src/gateway/server-discovery-runtime.js";
import { createGatewayPluginRuntimeGeneration } from "../../src/gateway/server-plugin-runtime-generation.js";
import {
  resolveWideAreaDiscoveryDomain,
  writeWideAreaGatewayZone,
} from "../../src/infra/widearea-dns.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
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

describe("gateway benchmark runtime selection", () => {
  it.each([undefined, "0,1,2,3"])(
    "keeps the selected executable and Gateway arguments together with affinity %s",
    (gatewayCpus) => {
      const gatewayRuntime = "/tmp/runtime with spaces/bun";
      const flags = new Map([["--gateway-runtime", [gatewayRuntime]]]);
      if (gatewayCpus) {
        flags.set("--gateway-cpus", [gatewayCpus]);
      }
      const args = buildGatewayBenchChildArgs("dist/entry.js", 18789, ["--import", "probe.ts"]);
      const options = parseGatewayBenchRuntimeOptions(flags);
      expect(buildGatewayBenchCommand(args, options, "linux")).toEqual({
        command: gatewayCpus ? "taskset" : gatewayRuntime,
        args: gatewayCpus ? ["--cpu-list", gatewayCpus, gatewayRuntime, ...args] : args,
      });
      expect(args.slice(0, 3)).toEqual(["--import", "probe.ts", "dist/entry.js"]);
    },
  );

  it.each(["", " --inspect", "bun\0other"])("rejects invalid executable %j", (value) => {
    expect(() =>
      parseGatewayBenchRuntimeOptions(new Map([["--gateway-runtime", [value]]])),
    ).toThrow("--gateway-runtime");
  });

  it.each(["0,1 "])("rejects invalid CPU list %j", (value) => {
    expect(() => parseGatewayBenchRuntimeOptions(new Map([["--gateway-cpus", [value]]]))).toThrow(
      "--gateway-cpus requires comma-separated CPU numbers",
    );
  });

  it.each(["win32"] as const)("rejects affinity on %s before spawn", (platform) => {
    expect(() =>
      buildGatewayBenchCommand(
        ["entry.js"],
        { gatewayRuntime: "bun", gatewayCpus: "0,1" },
        platform,
      ),
    ).toThrow("--gateway-cpus requires Linux taskset");
  });
});

describe("benchmark statistic units", () => {
  const stats = { p50: 1.5, avg: 1.5, min: 1, max: 2, p95: 2 };
  it.each([
    {
      name: "default duration",
      format: undefined,
      expected: "p50=1.5ms avg=1.5ms min=1.0ms max=2.0ms",
    },
    { name: "memory", format: formatMb, expected: "p50=1.5MB avg=1.5MB min=1.0MB max=2.0MB" },
  ])("formats $name", ({ format, expected }) => {
    expect(format === undefined ? formatStats(stats) : formatStats(stats, format)).toBe(expected);
  });

  it("keeps missing statistics unavailable", () => {
    const format = vi.fn(() => "unexpected");
    expect(formatStats(null, format)).toBe("n/a");
    expect(format).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("gateway benchmark discovery isolation", () => {
  it.each([
    { name: "benchmark fixture", enabled: false },
    { name: "enabled minimal-discovery control", enabled: true },
  ])("$name reaches the publication boundary with the expected policy", async ({ enabled }) => {
    const root = tempDirs.make("openclaw-bench-discovery-");
    const configPath = writeGatewayBenchConfig(
      root,
      {
        ...BASE_GATEWAY_BENCH_CONFIG,
        ...(enabled ? { discovery: { mdns: { mode: "minimal" } } } : {}),
      },
      {},
    );
    vi.stubEnv("OPENCLAW_WIDE_AREA_DOMAIN", "inherited.example.test");
    const childEnv = createGatewayBenchEnv(root, configPath, {});
    for (const key of [
      "HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "NODE_ENV",
      "VITEST",
      "OPENCLAW_DISABLE_BONJOUR",
      "OPENCLAW_WIDE_AREA_DOMAIN",
      "OPENCLAW_TAILNET_DNS",
      "OPENCLAW_CLI_PATH",
      "OPENCLAW_SSH_PORT",
      "OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS",
    ]) {
      vi.stubEnv(key, childEnv[key]);
    }
    const cfgAtStart: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const stop = vi.fn();
    const advertise = vi.fn(async () => ({ stop }));
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.gatewayDiscoveryServices.push({
      pluginId: "fixture-discovery",
      source: "test",
      id: "fixture-discovery",
      service: { id: "fixture-discovery", advertise },
    });

    const discovery = await startGatewayDiscovery({
      machineDisplayName: "Benchmark fixture",
      discovery: cfgAtStart.discovery,
      pluginRuntimeClaim: createGatewayPluginRuntimeGeneration({
        getServices: () => null,
        setServices: () => {},
      }).currentClaim(),
      port: 18789,
      gatewayTls: { enabled: false },
      gatewayDirectReachable: false,
      tailscaleMode: "off",
      logDiscovery: { info: vi.fn(), warn: vi.fn() },
      gatewayDiscoveryServices: pluginRegistry.gatewayDiscoveryServices,
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
});
