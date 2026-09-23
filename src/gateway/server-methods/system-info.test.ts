/** Gateway system.info method tests. */

import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSystemInfoResult } from "../../../packages/gateway-protocol/src/index.js";
import * as diskSpace from "../../infra/disk-space.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
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

describe("system.info", () => {
  let sampleTime = Date.now();
  beforeEach(() => {
    sampleTime += 10_001;
    vi.spyOn(Date, "now").mockReturnValue(sampleTime);
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    mocks.runCommandWithTimeout.mockReset().mockImplementation(mountedVolumeOutput);
    mocks.statfs.mockReset().mockImplementation(async (path: string) => ({
      blocks: path === "/" ? 1000n : 2000n,
      bavail: path === "/" ? 400n : 1500n,
      frsize: 1024n,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

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

    const request = {
      params: {},
      respond,
      context: {
        getRuntimeConfig: () => ({ gateway: { port: 18789 } }),
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

  it.each(["throw", "mount-exit", "statfs-error", "empty"])(
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
        context: { getRuntimeConfig: () => ({}) },
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
