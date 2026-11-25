import * as fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayConfigSchema } from "../config/zod-schema.gateway.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { getResourceProfile, onResourceProfileChange } from "../plugin-sdk/resource-profile.js";
import { resetGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  getGatewayResourceProfile,
  initializeGatewayResourceProfile,
  predictGatewayResourceProfile,
} from "./gateway-resource-profile.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: vi.fn(),
}));

const GiB = 1024 ** 3;
const files = new Map<string, string>();
beforeEach(() => {
  files.clear();
  files.set("/proc/self/cgroup", "0::/service/gateway\n");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(os, "totalmem").mockReturnValue(16 * GiB);
  vi.spyOn(os, "availableParallelism").mockReturnValue(8);
  vi.spyOn(fs, "readFileSync").mockImplementation((path) => {
    const value = files.get(String(path));
    if (value === undefined) {
      throw new Error("controller unavailable");
    }
    return value;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await resetGlobalSingletonLifecycleState(Symbol.for("openclaw.gatewayResourceProfile"));
});

it("publishes the owner's profile through the SDK and releases listeners", async () => {
  expect(getResourceProfile()).toBe("standard");
  const observed: string[] = [];
  const stopFailing = onResourceProfileChange(() => {
    throw new Error("plugin listener failed");
  });
  const stop = onResourceProfileChange((profile) => {
    expect(getResourceProfile()).toBe(profile);
    observed.push(profile);
  });
  expect(observed).toEqual([]);
  initializeGatewayResourceProfile({ profile: "lean" });
  initializeGatewayResourceProfile({ profile: "lean" });
  initializeGatewayResourceProfile({ profile: "standard" });
  expect(observed).toEqual(["lean", "standard"]);
  stop();
  stop();
  stopFailing();
  initializeGatewayResourceProfile({ profile: "lean" });
  expect(observed).toEqual(["lean", "standard"]);
  const disposed = vi.fn();
  onResourceProfileChange(disposed);
  await resetGlobalSingletonLifecycleState(Symbol.for("openclaw.gatewayResourceProfile"));
  expect(getResourceProfile()).toBe("standard");
  initializeGatewayResourceProfile({ profile: "lean" });
  expect(disposed).not.toHaveBeenCalled();
});

it.each([
  [1.5 * GiB, 8, "lean", "memory"],
  [4 * GiB, 8, "lean", "memory"],
  [8 * GiB - 1, 8, "lean", "memory"],
  [8 * GiB, 8, "standard", "capacity"],
  [8 * GiB, 1, "standard", "capacity"],
  [16 * GiB, 2, "standard", "capacity"],
])("auto resolves memory=%i CPUs=%i to %s", (memory, cpus, profile, reason) => {
  files.set("/sys/fs/cgroup/service/memory.max", String(memory));
  files.set("/sys/fs/cgroup/service/gateway/memory.max", "max");
  // memory.high is a reclaim trigger, not the hard profile limit.
  files.set("/sys/fs/cgroup/service/memory.high", "1");
  vi.mocked(os.availableParallelism).mockReturnValue(cpus);
  expect(initializeGatewayResourceProfile(undefined)).toEqual({
    configured: "auto",
    profile,
    reason,
    memoryLimitBytes: memory,
    memoryLimitSource: "cgroup-v2",
    cpus,
  });
});

it.each(["max", "invalid", undefined])(
  "falls back to RAM without a finite cgroup limit (%s)",
  (limit) => {
    if (limit) {
      files.set("/sys/fs/cgroup/memory.max", limit);
    }
    expect(initializeGatewayResourceProfile({ profile: "auto" })).toMatchObject({
      profile: "standard",
      memoryLimitBytes: 16 * GiB,
      memoryLimitSource: "host",
    });
  },
);

it.each([4, 8, 16])("uses host RAM with cgroup v1 (%i GiB)", (memoryGiB) => {
  files.set("/proc/self/cgroup", "5:memory:/service/gateway\n");
  files.set("/sys/fs/cgroup/memory/service/gateway/memory.limit_in_bytes", String(GiB));
  vi.mocked(os.totalmem).mockReturnValue(memoryGiB * GiB);
  expect(initializeGatewayResourceProfile(undefined)).toMatchObject({
    configured: "auto",
    profile: memoryGiB < 8 ? "lean" : "standard",
    memoryLimitBytes: memoryGiB * GiB,
    memoryLimitSource: "host",
  });
});

it("honors the namespace root and minimum ancestor, but never exceeds host RAM", () => {
  files.set("/proc/self/cgroup", "0::/\n");
  files.set("/sys/fs/cgroup/memory.max", String(1.5 * GiB));
  expect(initializeGatewayResourceProfile(undefined).memoryLimitBytes).toBe(1.5 * GiB);
  files.set("/proc/self/cgroup", "0::/service/gateway\n");
  files.set("/sys/fs/cgroup/service/gateway/memory.max", String(4 * GiB));
  expect(initializeGatewayResourceProfile(undefined).memoryLimitBytes).toBe(1.5 * GiB);
  files.set("/sys/fs/cgroup/memory.max", String(32 * GiB));
  files.delete("/sys/fs/cgroup/service/gateway/memory.max");
  expect(initializeGatewayResourceProfile(undefined).memoryLimitBytes).toBe(16 * GiB);
});

it("explicit profiles win and readers retain the startup decision until restart", async () => {
  files.set("/sys/fs/cgroup/memory.max", String(GiB));
  expect(initializeGatewayResourceProfile({ profile: "standard" })).toMatchObject({
    profile: "standard",
    reason: "explicit",
  });
  files.set("/sys/fs/cgroup/memory.max", String(8 * GiB));
  expect(getGatewayResourceProfile()?.memoryLimitBytes).toBe(GiB);
  expect(initializeGatewayResourceProfile({ profile: "lean" })).toMatchObject({
    profile: "lean",
    reason: "explicit",
  });
  await resetGlobalSingletonLifecycleState(Symbol.for("openclaw.gatewayResourceProfile"));
  expect(getGatewayResourceProfile()).toBeUndefined();
});

it.each([
  [undefined, 1.5 * GiB, "lean"],
  ["auto", 4 * GiB, "lean"],
  ["auto", 8 * GiB, "standard"],
  ["lean", 16 * GiB, "lean"],
  ["standard", 1.5 * GiB, "standard"],
] as const)(
  "predicts %s at %i bytes as startup will resolve it (%s)",
  (configured, memory, profile) => {
    files.set("/sys/fs/cgroup/service/gateway/memory.max", String(memory));
    expect(predictGatewayResourceProfile(configured)).toBe(profile);
    expect(getGatewayResourceProfile()).toBeUndefined();
    expect(
      initializeGatewayResourceProfile(configured ? { profile: configured } : undefined).profile,
    ).toBe(profile);
  },
);

it("uses host RAM off Linux and accepts only the documented config values", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  files.set("/sys/fs/cgroup/memory.max", "1");
  expect(initializeGatewayResourceProfile(undefined).memoryLimitSource).toBe("host");
  for (const profile of ["auto", "standard", "lean"]) {
    expect(GatewayConfigSchema.safeParse({ resources: { profile } }).success).toBe(true);
  }
  expect(GatewayConfigSchema.safeParse({ resources: { profile: "throughput" } }).success).toBe(
    false,
  );
  expect(buildGatewayReloadPlan(["gateway.resources.profile"]).restartGateway).toBe(true);
});
