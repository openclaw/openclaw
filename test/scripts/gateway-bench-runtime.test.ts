import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as bench from "../../scripts/lib/gateway-bench-runtime.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("writes inactive benchmark plugins when startup activation is disabled", () => {
  const root = tempDirs.make("gateway-plugin-load-");
  const fixtures = bench.writePluginFixtures(root, { count: 1, activationOnStartup: false });
  expect(loadPluginManifest(path.join(fixtures.pluginsDir, "bench-plugin-01"))).toMatchObject({
    ok: true,
    manifest: { id: "bench-plugin-01", activation: { onStartup: false } },
  });
});

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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("isolates benchmarks from ambient discovery", () => {
  const root = tempDirs.make("openclaw-bench-discovery-");
  const configPath = bench.writeGatewayBenchConfig(root, bench.BASE_GATEWAY_BENCH_CONFIG, {});
  vi.stubEnv("OPENCLAW_WIDE_AREA_DOMAIN", "inherited.example.test");
  expect(JSON.parse(readFileSync(configPath, "utf8")).discovery).toEqual({ mdns: { mode: "off" } });
  expect(
    bench.createGatewayBenchEnv(root, configPath, {}).OPENCLAW_WIDE_AREA_DOMAIN,
  ).toBeUndefined();
});
