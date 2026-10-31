/** Gateway system.info method tests. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSystemInfoResult } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as diskSpace from "../../infra/disk-space.js";
import { inspectGatewayLockRecovery } from "../../infra/gateway-lock-recovery.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveAdvertisedLanHostCore: vi.fn(async () => "192.168.1.20"),
  runCommandWithTimeout: vi.fn(),
  statfs: vi.fn(),
}));

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: {
      ...actual,
      stat: (...args: Parameters<typeof actual.stat>) => {
        if (args[0] === "/Volumes/Data") {
          return Promise.resolve({ dev: 2n });
        }
        if (args[0] === "/dev/data") {
          return Promise.resolve({ rdev: 2n });
        }
        return actual.stat(...args);
      },
      statfs: mocks.statfs,
    },
  };
});

const mountedVolumeOutput = () => ({
  code: 0,
  stdout: "/dev/root on / (apfs, local)\n/dev/data on /Volumes/Data (apfs, local)\n",
  stderr: "",
});

// Keep every real export available: other modules in the import graph may pull
// parse/select helpers from this module, and a partial factory would break them.
vi.mock("../../infra/advertised-lan-host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/advertised-lan-host.js")>()),
  resolveAdvertisedLanHostCore: mocks.resolveAdvertisedLanHostCore,
}));

import { systemHandlers } from "./system.js";

const ownerTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("system.info native state owner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reports the held native owner and never adopts a copied owner record", async () => {
    const root = ownerTempDirs.make("system-info-owner-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    mocks.statfs.mockResolvedValue({ blocks: 1000n, bavail: 400n, frsize: 1024n });
    mocks.runCommandWithTimeout.mockResolvedValue(mountedVolumeOutput());
    const respond = vi.fn();
    const request = {
      params: {},
      respond,
      context: createModelsListTestContext({ cfg: {}, catalog: [] }),
    } as unknown as GatewayRequestHandlerOptions;
    const handler = expectDefined(systemHandlers["system.info"], "system.info handler");
    const lock = expectDefined(
      await acquireGatewayLock({
        allowInTests: true,
        timeoutMs: 0,
        port: 18789,
        listenerMode: "foreground",
      }),
      "native Gateway owner",
    );
    const recorded = fs.readFileSync(lock.lockPath, "utf8");
    try {
      await handler(request);
      const payload = respond.mock.calls[0]?.[1];
      if (!validateSystemInfoResult(payload)) {
        throw new Error("system.info returned an invalid payload");
      }
      expect(payload?.stateOwner).toMatchObject({
        databasePath: path.join(fs.realpathSync(root), "state", "openclaw.sqlite"),
        ownerId: JSON.parse(recorded).ownerId,
        role: "gateway",
        pid: process.pid,
        processNamespace: { platform: process.platform, host: os.hostname() },
      });
      if (process.platform === "linux") {
        expect(payload?.stateOwner?.processNamespace).toEqual({
          platform: "linux",
          host: os.hostname(),
          identity: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
          pidNsInode: fs.readlinkSync("/proc/self/ns/pid").match(/^pid:\[(\d+)\]$/u)?.[1],
        });
        expect(payload?.stateOwner?.startTime).toBeGreaterThan(0);
      }
      const inspection = await inspectGatewayLockRecovery();
      expect(inspection.ownerRecords).toEqual([
        { kind: "state-owner", owner: payload.stateOwner },
        { kind: "state-lock", owner: payload.stateOwner },
        { kind: "gateway-lease", owner: payload.stateOwner },
      ]);
    } finally {
      await lock.release();
    }
    // Even this live PID's old record does not establish current in-process custody.
    fs.mkdirSync(path.dirname(lock.lockPath), { recursive: true });
    fs.writeFileSync(lock.lockPath, recorded);
    await handler(request);
    expect(respond.mock.calls[1]?.[1]).not.toHaveProperty("stateOwner");
  });
});

describe("system.info", () => {
  let sampleTime = Date.now();
  beforeEach(() => {
    sampleTime = Math.max(sampleTime, Date.now()) + 30_001;
    vi.spyOn(Date, "now").mockReturnValue(sampleTime);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    mocks.runCommandWithTimeout.mockReset().mockImplementation(mountedVolumeOutput);
    mocks.statfs.mockReset().mockImplementation(async (mountPath: string) => ({
      blocks: mountPath === "/" ? 1000n : 2000n,
      bavail: mountPath === "/" ? 400n : 1500n,
      frsize: 1024n,
    }));
  });
  afterEach(() => {
    sampleTime = Math.max(sampleTime, Date.now());
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns a schema-valid host resource snapshot", async () => {
    const readCpus = vi.spyOn(os, "cpus");
    const respond = vi.fn();
    const eventLoop = {
      degraded: false,
      degradedSinceMs: null,
      reasons: [],
      intervalMs: 1000,
      delayP99Ms: 12,
      delayMaxMs: 20,
      utilization: 0.25,
      cpuCoreRatio: 0.3,
      cpuBreakdown: {
        mainThreadCoreRatio: 0.1,
        workerCoreRatio: 0.15,
        otherThreadsCoreRatio: 0.05,
        hostUtilization: 0.7,
        hostCpuCount: 8,
      },
    };
    const getEventLoopHealth = vi.fn(() => ({ ...eventLoop }));
    vi.spyOn(process, "availableMemory").mockReturnValue(4096);

    const request = {
      params: {},
      respond,
      context: {
        ...createModelsListTestContext({
          cfg: { gateway: { port: 18789 } },
          catalog: [],
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
        }),
        getEventLoopHealth,
      },
    } as unknown as GatewayRequestHandlerOptions;

    const handler = expectDefined(
      systemHandlers["system.info"],
      'systemHandlers["system.info"] test invariant',
    );
    await handler(request);
    eventLoop.cpuCoreRatio = 0.6;
    readCpus.mockReturnValue([]);
    vi.mocked(Date.now).mockReturnValue(sampleTime + 1_999);
    await handler(request);

    expect(respond).toHaveBeenCalledTimes(2);
    expect(mocks.runCommandWithTimeout.mock.calls.map(([argv]) => argv)).toEqual([["mount"]]);
    expect(mocks.resolveAdvertisedLanHostCore).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    if (!validateSystemInfoResult(payload)) {
      throw new Error("system.info returned an invalid payload");
    }
    expect(payload.cpuCount).toBeGreaterThanOrEqual(1);
    expect(payload.memoryTotalBytes).toBeGreaterThan(0);
    expect(payload.memoryFreeBytes).toBe(4096);
    expect(payload.processInstanceId).toBe(getGatewayProcessInstanceId());
    expect(payload.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(payload.defaultAgentUtilityModel).toEqual({ status: "unavailable" });
    expect(payload.eventLoop?.cpuCoreRatio).toBe(0.3);
    expect(payload.eventLoop?.cpuBreakdown).toEqual(eventLoop.cpuBreakdown);
    expect(payload.processMemory?.rssBytes).toBeGreaterThan(0);
    expect(payload.processMemory?.heapUsedBytes).toBeGreaterThan(0);
    const refreshed = respond.mock.calls[1]?.[1];
    if (!validateSystemInfoResult(refreshed)) {
      throw new Error("system.info returned an invalid refreshed payload");
    }
    expect(refreshed.eventLoop?.cpuCoreRatio).toBe(0.6);
    expect(refreshed.cpuCount).toBe(payload.cpuCount);
    expect(refreshed.cpuModel).toBe(payload.cpuModel);
    expect(readCpus).not.toHaveBeenCalled();
    expect(refreshed.eventLoop?.cpuBreakdown).toEqual(eventLoop.cpuBreakdown);
    expect(getEventLoopHealth).toHaveBeenCalledTimes(2);
    expect(payload).toHaveProperty("disks", [
      { path: "/", totalBytes: 1_024_000, availableBytes: 409_600 },
      { path: "/Volumes/Data", totalBytes: 2_048_000, availableBytes: 1_536_000 },
    ]);

    sampleTime += 24 * 60 * 60_000;
    vi.mocked(Date.now).mockReturnValue(sampleTime);
    await handler(request);
    expect(readCpus).not.toHaveBeenCalled();
    expect(respond.mock.calls[2]?.[1]).toMatchObject({
      cpuCount: payload.cpuCount,
      cpuModel: payload.cpuModel,
      eventLoop: { cpuCoreRatio: 0.6 },
    });
  });

  it("keeps each utility route on its prepared owner across requests with the same config", async () => {
    const config = {
      models: {
        providers: {
          custom: {
            api: "openai-completions" as const,
            baseUrl: "https://custom.example/v1",
            apiKey: "synthetic-key",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: "custom/main",
          utilityModel: "custom/small",
          models: { "custom/small": { agentRuntime: { id: "utility-test" } } },
        },
      },
    };
    const respond = vi.fn();
    const handler = expectDefined(systemHandlers["system.info"], "system.info handler");
    const ambientRegistry = createEmptyPluginRegistry();
    for (const label of ["First Owner", "Replacement Owner"]) {
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.agentHarnesses.push({
        pluginId: "utility-test",
        source: "runtime",
        harness: {
          id: "utility-test",
          label,
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
          runIsolatedCompletionV2: vi.fn(),
        },
      });
      await withPluginRuntimeRegistryScope(ambientRegistry, () =>
        handler({
          params: {},
          respond,
          context: createModelsListTestContext({
            cfg: config,
            catalog: [providerCatalogEntry("custom", "small")],
            pluginRegistry,
          }),
        } as unknown as GatewayRequestHandlerOptions),
      );
      expect(respond.mock.lastCall?.[1].defaultAgentUtilityModel.runtime).toEqual({
        id: "utility-test",
        kind: "harness",
        label,
      });
    }
  });

  it.each([false, true])(
    "bounds state-volume reads, keeps live counters and invalidates on expiry or path change (unavailable=%s)",
    async (unavailable) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/system-info-first");
      vi.spyOn(process, "uptime").mockReturnValue(123);
      vi.spyOn(process, "memoryUsage").mockReturnValue(process.memoryUsage());
      const freemem = vi.spyOn(os, "freemem").mockReturnValue(1024);
      const availableMemory = vi.spyOn(process, "availableMemory").mockReturnValue(1024);
      const loadavg = vi.spyOn(os, "loadavg").mockReturnValue([1, 2, 3]);
      const readDisk = vi
        .spyOn(diskSpace, "tryReadDiskSpace")
        .mockImplementation((targetPath) =>
          unavailable
            ? null
            : { targetPath, checkedPath: targetPath, totalBytes: 2048, availableBytes: 1024 },
        );
      const respond = vi.fn();
      const request = {
        params: {},
        respond,
        context: createModelsListTestContext({ cfg: {}, catalog: [] }),
      } as unknown as GatewayRequestHandlerOptions;
      const handler = expectDefined(systemHandlers["system.info"], "system.info handler");
      await handler(request);
      const initial = respond.mock.calls[0]?.[1];
      freemem.mockReturnValue(512);
      availableMemory.mockReturnValue(512);
      loadavg.mockReturnValue([4, 5, 6]);
      readDisk.mockImplementation((targetPath) => ({
        targetPath,
        checkedPath: targetPath,
        totalBytes: 2048,
        availableBytes: 256,
      }));
      vi.mocked(Date.now).mockReturnValue(sampleTime + 29_999);
      await handler(request);
      expect(readDisk).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[1]?.[1]).toEqual({
        ...initial,
        memoryFreeBytes: 512,
        loadAverage: [4, 5, 6],
      });
      vi.mocked(Date.now).mockReturnValue(sampleTime + 30_000);
      await handler(request);
      expect(readDisk).toHaveBeenCalledTimes(2);
      expect(respond.mock.calls[2]?.[1]).toMatchObject({
        diskAvailableBytes: 256,
        diskPath: "/system-info-first",
      });
      vi.stubEnv("OPENCLAW_STATE_DIR", "/system-info-second");
      await handler(request);
      expect(readDisk).toHaveBeenCalledTimes(3);
      expect(respond.mock.calls[3]?.[1]).toMatchObject({ diskPath: "/system-info-second" });
    },
  );

  it.each(["linux"] as const)("keeps host-wide memory readings on %s", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.spyOn(os, "platform").mockReturnValue(platform);
    vi.spyOn(os, "freemem").mockReturnValue(8192);
    const availableMemory = vi.spyOn(process, "availableMemory").mockReturnValue(4096);

    const respond = vi.fn();
    await expectDefined(
      systemHandlers["system.info"],
      "system.info handler",
    )({
      params: {},
      respond,
      context: createModelsListTestContext({ cfg: {}, catalog: [] }),
    } as unknown as GatewayRequestHandlerOptions);

    const [ok, payload] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    if (!validateSystemInfoResult(payload)) {
      throw new Error("system.info returned an invalid payload");
    }
    expect(payload.memoryFreeBytes).toBe(8192);
    expect(availableMemory).not.toHaveBeenCalled();
  });

  it.each(["throw", "empty"])(
    "preserves the state-directory snapshot only when discovery is unavailable (%s)",
    async (failure) => {
      vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
        targetPath,
        checkedPath: targetPath,
        totalBytes: 2048,
        availableBytes: 1024,
      }));
      if (failure === "throw") {
        mocks.runCommandWithTimeout.mockRejectedValueOnce(new Error("unavailable"));
      } else if (failure === "statfs-error") {
        mocks.statfs.mockRejectedValue(new Error("filesystem unavailable"));
      } else {
        mocks.runCommandWithTimeout.mockResolvedValueOnce({
          code: failure === "empty" ? 0 : 1,
          stdout: "",
          stderr: "",
        });
      }
      const respond = vi.fn();
      await expectDefined(
        systemHandlers["system.info"],
        "system.info handler",
      )({
        params: {},
        respond,
        context: createModelsListTestContext({ cfg: {}, catalog: [] }),
      } as unknown as GatewayRequestHandlerOptions);
      const [ok, payload] = respond.mock.calls[0] ?? [];
      expect(ok).toBe(true);
      if (!validateSystemInfoResult(payload)) {
        throw new Error("system.info returned an invalid payload");
      }
      expect(payload.disks).toEqual(
        failure === "empty"
          ? []
          : [{ path: payload.diskPath, totalBytes: 2048, availableBytes: 1024 }],
      );
    },
  );
});
