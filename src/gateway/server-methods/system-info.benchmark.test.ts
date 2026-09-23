import os from "node:os";
import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveStateDir } from "../../config/paths.js";
import * as diskSpace from "../../infra/disk-space.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../../infra/advertised-lan-host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/advertised-lan-host.js")>()),
  resolveAdvertisedLanHostCore: async () => "192.0.2.1",
}));
vi.mock("../../infra/system-disks.js", () => ({ readSystemDisks: async () => [] }));
vi.mock("../../infra/machine-name.js", () => ({ getMachineDisplayName: async () => "benchmark" }));

import { systemHandlers } from "./system.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.runIf(process.env.OPENCLAW_SYSTEM_INFO_BENCH === "1")(
  "measures warmed system.info calls with native OS, disk and process reads",
  async () => {
    const handler = expectDefined(systemHandlers["system.info"], "handler");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("system-info-bench-"));
    const config = {
      agents: { entries: { main: { utilityModel: "" } } },
      gateway: { port: 18789 },
    };
    let responses = 0;
    const request = {
      params: {},
      respond: () => {
        responses++;
      },
      context: { getRuntimeConfig: () => config },
    } as unknown as GatewayRequestHandlerOptions;
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    for (let i = 0; i < 1000; i++) {
      await handler(request);
    }
    for (const intervalMs of [1667, 20]) {
      const samples: number[] = [];
      const cpuSamples: number[] = [];
      for (let round = 0; round < 7; round++) {
        const cpuStart = process.cpuUsage();
        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
          clock += intervalMs;
          await handler(request);
        }
        const cpu = process.cpuUsage(cpuStart);
        samples.push(((performance.now() - start) * 1000) / 1000);
        cpuSamples.push((cpu.user + cpu.system) / 1000);
      }
      console.log(
        JSON.stringify({
          kind: "handler",
          intervalMs,
          medianUs: samples.toSorted((a, b) => a - b)[3],
          medianCpuUs: cpuSamples.toSorted((a, b) => a - b)[3],
          samplesUs: samples,
        }),
      );
    }
    const stateDir = resolveStateDir();
    for (const [name, read] of Object.entries({
      cpus: () => os.cpus(),
      disk: () => diskSpace.tryReadDiskSpace(stateDir),
      memoryUsage: () => process.memoryUsage(),
      loadavg: () => os.loadavg(),
      freemem: () => os.freemem(),
    })) {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        read();
      }
      console.log(
        JSON.stringify({
          kind: "primitive",
          name,
          meanUs: ((performance.now() - start) * 1000) / 1000,
        }),
      );
    }
    expect(responses).toBe(15000);
  },
  30_000,
);
