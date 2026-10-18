import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import {
  createTsgoResourceSampler,
  parseTsgoProcessSample,
  runMeasuredTsgoCommand,
  summarizeTsgoBuildInfo,
} from "../../scripts/lib/tsgo-performance.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../scripts/lib/managed-child-process.mts", () => ({ runManagedCommand: vi.fn() }));
const managed = vi.mocked(runManagedCommand);
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

it.each([
  ["unsupported-platform", 0, null, null],
  ["clock-tick-frequency-unavailable", 0, null, null],
  ["exit-race", 5, 150, 1048576],
  ["missing-rss", 2, 150, null],
] as const)("preserves resource evidence for %s", (scenario, reads, cpuMs, peakRssBytes) => {
  const samples = [
    stat(),
    "VmHWM: 1024 kB\n",
    new Error("ENOENT"),
    stat({ user: 500, start: "456" }),
    "VmHWM: 4096 kB\n",
  ];
  const read = vi.fn((file: string) => {
    const value = scenario === "exit-race" ? samples.shift() : file.endsWith("stat") ? stat() : "";
    if (value instanceof Error) {
      throw value;
    }
    return value ?? "";
  });
  const sampler = createTsgoResourceSampler({
    platform: scenario === "unsupported-platform" ? "darwin" : "linux",
    ticksPerSecond: scenario === "clock-tick-frequency-unavailable" ? null : 100,
    read,
  });
  for (let attempt = 0; attempt < (scenario === "exit-race" ? 3 : 1); attempt++) {
    sampler.sample(42);
  }
  expect(read).toHaveBeenCalledTimes(reads);
  expect(sampler.result()).toMatchObject({
    cpuMs,
    peakRssBytes,
    samples: reads ? 1 : 0,
    unavailableReason: reads ? null : scenario,
    ...(scenario === "exit-race" ? { accuracy: "sampled-lower-bound" } : {}),
    ...(scenario === "missing-rss"
      ? { peakRssUnavailableReason: "rss-high-water-unavailable" }
      : {}),
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
  for (const [before, after, unavailableReason] of [
    [info, info, "build-info-unchanged"],
    [null, null, "build-info-unavailable"],
    ...["not JSON", '{"fileNames":[],"root":[[1,999999999]]}', '{"fileNames":[]}'].map(
      (text) => [null, Buffer.from(text), "unsupported-build-info"] as const,
    ),
  ] as const) {
    expect(summarizeTsgoBuildInfo(before, after)).toMatchObject({
      totalFiles: null,
      rootFiles: null,
      unavailableReason,
    });
  }
});

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
    run: (overrides: Partial<Parameters<typeof runManagedCommand>[0]> = {}, output = directory) =>
      runMeasuredTsgoCommand({ ...command, ...overrides }, output),
    evidence: () => {
      const [artifact] = fs.readdirSync(directory);
      if (!artifact) {
        throw new Error("Missing compiler metrics artifact");
      }
      return JSON.parse(fs.readFileSync(path.join(directory, artifact), "utf8"));
    },
  };
}

it.each([
  { exitCode: 2, signal: null },
  { exitCode: 143, signal: "SIGTERM" },
] as const)(
  "preserves managed outcome $exitCode and its evidence",
  async ({ exitCode, signal }) => {
    const { cwd, command, run, evidence } = fixture();
    const onReady = vi.fn();
    const onSignal = vi.fn();
    managed.mockImplementationOnce(async (options) => {
      expect(options).toMatchObject(command);
      expect(options.stdio).toBeUndefined();
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        exitCode: null,
        signalCode: null,
      });
      options.onReady?.(child as Parameters<NonNullable<typeof options.onReady>>[0]);
      if (signal) {
        options.onSignal?.(signal);
      } else {
        fs.writeFileSync(
          path.join(cwd, "cache.tsbuildinfo"),
          '{"fileNames":["a.ts","lib.d.ts"],"root":[1]}',
        );
      }
      child.emit("exit", signal ? null : exitCode, signal);
      return exitCode;
    });
    expect(await run(signal ? { onSignal } : { onReady })).toBe(exitCode);
    expect(evidence().outcome).toMatchObject({
      exitCode,
      errorCode: null,
      exitSignal: signal,
      forwardedSignal: signal,
    });
    if (signal) {
      expect(onSignal).toHaveBeenCalledWith(signal);
      return;
    }
    expect(onReady).toHaveBeenCalledOnce();
    expect(evidence()).toMatchObject({
      command: { args: command.args },
      pprofDir: "profiles",
      graph: { totalFiles: 2, rootFiles: 1, transitiveFiles: 1 },
      cache: { beforeSha256: null, hit: "unknown", osPageCache: "uncontrolled" },
    });
    expect(evidence().wallMs).toBeGreaterThanOrEqual(0);
    expect(evidence().cache.afterSha256).toMatch(/^[a-f0-9]{64}$/u);
  },
);

it("never replaces a managed failure with an evidence result", async () => {
  const { run, evidence } = fixture();
  const code = "EPROCESSGROUP_CLEANUP_FAILED";
  const error = Object.assign(new Error("compiler failure"), { code });
  managed.mockRejectedValueOnce(error);
  await expect(run()).rejects.toBe(error);
  expect(evidence().outcome).toMatchObject({ exitCode: null, errorCode: code });
});

it.each(["setup", "write"] as const)(
  "preserves compiler outcomes when evidence %s fails",
  async (phase) => {
    const { cwd, directory, run } = fixture();
    if (phase === "write") {
      managed.mockResolvedValue(0);
      await run();
      await run();
      expect(fs.readdirSync(directory)).toHaveLength(2);
    }
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = phase === "setup" ? 7 : 9;
    managed.mockImplementationOnce(async () => {
      if (phase === "write") {
        fs.rmSync(directory, { recursive: true });
      }
      return exitCode;
    });
    const calls = managed.mock.calls.length;
    expect(
      await run({}, phase === "setup" ? path.join(cwd, "package.json", "metrics") : directory),
    ).toBe(exitCode);
    expect(managed.mock.calls.length - calls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(phase === "setup" ? "without metrics" : "compiler outcome preserved"),
    );
  },
);
