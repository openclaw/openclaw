import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import {
  createTsgoResourceSampler,
  parseTsgoProcessSample,
  runMeasuredTsgoCommand,
  summarizeTsgoBuildInfo,
} from "../../scripts/lib/tsgo-performance.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../scripts/lib/managed-child-process.mts", () => ({ runManagedCommand: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function stat({ user = 10, system = 5, start = "123" } = {}) {
  const fields = Array<string>(20).fill("0");
  fields[0] = "R";
  fields[11] = String(user);
  fields[12] = String(system);
  fields[19] = start;
  return `42 (tsgo (worker)) ${fields.join(" ")}`;
}

it("parses all-thread CPU and kernel RSS high-water observations without confusing comm fields", () => {
  expect(parseTsgoProcessSample(stat(), "VmHWM:\t1024 kB\n", 100)).toEqual({
    startTicks: "123",
    cpuMs: 150,
    peakRssBytes: 1048576,
  });
  expect(parseTsgoProcessSample("garbled", "", 100)).toBeNull();
  expect(parseTsgoProcessSample(stat(), "", 0)).toBeNull();
  expect(parseTsgoProcessSample(stat(), "", 100)?.peakRssBytes).toBeNull();
});

it.each(["darwin", "win32"] as const)(
  "reports resource statistics unavailable on %s without reading procfs",
  (platform) => {
    const read = vi.fn();
    const sampler = createTsgoResourceSampler({ platform, ticksPerSecond: 100, read });
    sampler.sample(42);
    expect(read).not.toHaveBeenCalled();
    expect(sampler.result()).toMatchObject({
      cpuMs: null,
      peakRssBytes: null,
      samples: 0,
      unavailableReason: "unsupported-platform",
    });
  },
);

it("keeps lower bounds across exit races and refuses a reused PID", () => {
  const read = vi
    .fn()
    .mockReturnValueOnce(stat())
    .mockReturnValueOnce("VmHWM: 1024 kB\n")
    .mockImplementationOnce(() => {
      throw new Error("ENOENT");
    })
    .mockReturnValueOnce(stat({ user: 500, start: "456" }))
    .mockReturnValueOnce("VmHWM: 4096 kB\n");
  const sampler = createTsgoResourceSampler({ platform: "linux", ticksPerSecond: 100, read });
  sampler.sample(42);
  sampler.sample(42);
  sampler.sample(42);
  expect(sampler.result()).toMatchObject({
    cpuMs: 150,
    peakRssBytes: 1048576,
    samples: 1,
    accuracy: "sampled-lower-bound",
  });
  const missing = createTsgoResourceSampler({ platform: "linux", ticksPerSecond: null, read });
  missing.sample(42);
  expect(missing.result()).toMatchObject({
    cpuMs: null,
    unavailableReason: "clock-tick-frequency-unavailable",
  });
});

it("explains a missing RSS high-water mark separately from available CPU", () => {
  const sampler = createTsgoResourceSampler({
    platform: "linux",
    ticksPerSecond: 100,
    read: (file) => (file.endsWith("stat") ? stat() : ""),
  });
  sampler.sample(42);
  expect(sampler.result()).toMatchObject({
    cpuMs: 150,
    peakRssBytes: null,
    unavailableReason: null,
    peakRssUnavailableReason: "rss-high-water-unavailable",
  });
});

it("counts roots and transitive inputs only from fresh compiler metadata", () => {
  const info = Buffer.from(
    JSON.stringify({ fileNames: ["a.ts", "b.ts", "c.ts", "lib.d.ts"], root: [[1, 2], 2] }),
  );
  expect(summarizeTsgoBuildInfo(null, info)).toEqual({
    rootFiles: 2,
    transitiveFiles: 2,
    totalFiles: 4,
    unavailableReason: null,
  });
  expect(summarizeTsgoBuildInfo(info, info)).toMatchObject({
    totalFiles: null,
    unavailableReason: "build-info-unchanged",
  });
  expect(summarizeTsgoBuildInfo(null, null)).toMatchObject({
    totalFiles: null,
    unavailableReason: "build-info-unavailable",
  });
  for (const unsupported of [
    "not JSON",
    '{"fileNames":[],"root":[[1,999999999]]}',
    '{"fileNames":[]}',
  ]) {
    expect(summarizeTsgoBuildInfo(null, Buffer.from(unsupported))).toMatchObject({
      rootFiles: null,
      unavailableReason: "unsupported-build-info",
    });
  }
});

describe("managed compiler evidence", () => {
  function fixture() {
    const cwd = tempDirs.make("tsgo-performance-");
    fs.writeFileSync(path.join(cwd, "package.json"), '{"private":true}');
    const directory = path.join(cwd, "metrics");
    const command = {
      bin: "tsgo",
      args: [
        "-p",
        "fixture.json",
        "--tsBuildInfoFile",
        "cache.tsbuildinfo",
        "--pprofDir",
        "profiles",
      ],
      cwd,
      env: {},
      timeoutMs: 10_000,
      requireProcessTreeExit: true,
    };
    return {
      cwd,
      directory,
      command,
      evidence: () => {
        const [artifact] = fs.readdirSync(directory);
        if (!artifact) {
          throw new Error("Missing compiler metrics artifact");
        }
        return JSON.parse(fs.readFileSync(path.join(directory, artifact), "utf8"));
      },
    };
  }

  it("preserves command, output policy, callbacks and numeric failure while recording fresh graph/cache evidence", async () => {
    const { cwd, directory, command, evidence } = fixture();
    const onReady = vi.fn();
    vi.mocked(runManagedCommand).mockImplementationOnce(async (options) => {
      expect(options).toMatchObject(command);
      expect(options.stdio).toBeUndefined();
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        exitCode: null,
        signalCode: null,
      });
      options.onReady?.(child as Parameters<NonNullable<typeof options.onReady>>[0]);
      fs.writeFileSync(
        path.join(cwd, "cache.tsbuildinfo"),
        '{"fileNames":["a.ts","lib.d.ts"],"root":[1]}',
      );
      child.emit("exit", 2, null);
      return 2;
    });
    expect(await runMeasuredTsgoCommand({ ...command, onReady }, directory)).toBe(2);
    expect(onReady).toHaveBeenCalledOnce();
    expect(evidence()).toMatchObject({
      outcome: { exitCode: 2, errorCode: null },
      command: { args: command.args },
      pprofDir: "profiles",
      graph: { totalFiles: 2, rootFiles: 1, transitiveFiles: 1 },
      cache: { beforeSha256: null, hit: "unknown", osPageCache: "uncontrolled" },
    });
    expect(evidence().wallMs).toBeGreaterThanOrEqual(0);
    expect(evidence().cache.afterSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("records forwarded and child signals while leaving the managed result authoritative", async () => {
    const { directory, command, evidence } = fixture();
    const onSignal = vi.fn();
    vi.mocked(runManagedCommand).mockImplementationOnce(async (options) => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
      options.onReady?.(child as Parameters<NonNullable<typeof options.onReady>>[0]);
      options.onSignal?.("SIGTERM");
      child.emit("exit", null, "SIGTERM");
      return 143;
    });
    expect(await runMeasuredTsgoCommand({ ...command, onSignal }, directory)).toBe(143);
    expect(onSignal).toHaveBeenCalledWith("SIGTERM");
    expect(evidence().outcome).toMatchObject({
      exitCode: 143,
      exitSignal: "SIGTERM",
      forwardedSignal: "SIGTERM",
    });
  });

  it.each(["ETIMEDOUT", "ENOENT", "EPROCESSGROUP_CLEANUP_FAILED"])(
    "never replaces %s with an evidence result",
    async (code) => {
      const { directory, command, evidence } = fixture();
      const error = Object.assign(new Error("compiler failure"), { code });
      vi.mocked(runManagedCommand).mockRejectedValueOnce(error);
      await expect(runMeasuredTsgoCommand(command, directory)).rejects.toBe(error);
      expect(evidence().outcome).toMatchObject({ exitCode: null, errorCode: code });
    },
  );

  it("does not turn unavailable evidence output into a compiler failure or rerun", async () => {
    const { cwd, command } = fixture();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runManagedCommand).mockResolvedValueOnce(7);
    const calls = vi.mocked(runManagedCommand).mock.calls.length;
    expect(await runMeasuredTsgoCommand(command, path.join(cwd, "package.json", "metrics"))).toBe(
      7,
    );
    expect(vi.mocked(runManagedCommand).mock.calls.length - calls).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without metrics"));
  });

  it("writes separate artifacts for repeated invocations and preserves outcomes if final writing fails", async () => {
    const { directory, command } = fixture();
    vi.mocked(runManagedCommand).mockResolvedValue(0);
    await runMeasuredTsgoCommand(command, directory);
    await runMeasuredTsgoCommand(command, directory);
    expect(fs.readdirSync(directory)).toHaveLength(2);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runManagedCommand).mockImplementationOnce(async () => {
      fs.rmSync(directory, { recursive: true });
      return 9;
    });
    expect(await runMeasuredTsgoCommand(command, directory)).toBe(9);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("compiler outcome preserved"));
  });
});
