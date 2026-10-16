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

it.each([
  "unsupported-platform",
  "clock-tick-frequency-unavailable",
  "exit-race",
  "missing-rss",
] as const)("preserves resource evidence for %s", (scenario) => {
  const read = vi.fn<(file: string) => string>();
  if (scenario === "missing-rss") {
    read.mockImplementation((file) => (file.endsWith("stat") ? stat() : ""));
  }
  if (scenario === "exit-race") {
    read
      .mockReturnValueOnce(stat())
      .mockReturnValueOnce("VmHWM: 1024 kB\n")
      .mockImplementationOnce(() => {
        throw new Error("ENOENT");
      })
      .mockReturnValueOnce(stat({ user: 500, start: "456" }))
      .mockReturnValueOnce("VmHWM: 4096 kB\n");
  }
  const sampler = createTsgoResourceSampler({
    platform: scenario === "unsupported-platform" ? "darwin" : "linux",
    ticksPerSecond: scenario === "clock-tick-frequency-unavailable" ? null : 100,
    read,
  });
  for (let attempt = 0; attempt < (scenario === "exit-race" ? 3 : 1); attempt++) {
    sampler.sample(42);
  }
  if (scenario === "exit-race") {
    expect(read).toHaveBeenCalledTimes(5);
    expect(sampler.result()).toMatchObject({
      cpuMs: 150,
      peakRssBytes: 1048576,
      samples: 1,
      accuracy: "sampled-lower-bound",
    });
  } else if (scenario === "missing-rss") {
    expect(read).toHaveBeenCalledTimes(2);
    expect(sampler.result()).toMatchObject({
      cpuMs: 150,
      peakRssBytes: null,
      unavailableReason: null,
      peakRssUnavailableReason: "rss-high-water-unavailable",
    });
  } else {
    expect(read).not.toHaveBeenCalled();
    expect(sampler.result()).toMatchObject({
      cpuMs: null,
      peakRssBytes: null,
      samples: 0,
      unavailableReason: scenario,
    });
  }
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

  it.each([
    { exitCode: 2, signal: null },
    { exitCode: 143, signal: "SIGTERM" },
  ] as const)(
    "preserves managed outcome $exitCode and its evidence",
    async ({ exitCode, signal }) => {
      const { cwd, directory, command, evidence } = fixture();
      const onReady = vi.fn();
      const onSignal = vi.fn();
      vi.mocked(runManagedCommand).mockImplementationOnce(async (options) => {
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
      expect(
        await runMeasuredTsgoCommand(
          { ...command, ...(signal ? { onSignal } : { onReady }) },
          directory,
        ),
      ).toBe(exitCode);
      if (signal) {
        expect(onSignal).toHaveBeenCalledWith(signal);
        expect(evidence().outcome).toMatchObject({
          exitCode,
          errorCode: null,
          exitSignal: signal,
          forwardedSignal: signal,
        });
        return;
      }
      expect(onReady).toHaveBeenCalledOnce();
      expect(evidence()).toMatchObject({
        outcome: { exitCode: 2, errorCode: null, exitSignal: null, forwardedSignal: null },
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
    const { directory, command, evidence } = fixture();
    const code = "EPROCESSGROUP_CLEANUP_FAILED";
    const error = Object.assign(new Error("compiler failure"), { code });
    vi.mocked(runManagedCommand).mockRejectedValueOnce(error);
    await expect(runMeasuredTsgoCommand(command, directory)).rejects.toBe(error);
    expect(evidence().outcome).toMatchObject({ exitCode: null, errorCode: code });
  });

  it.each(["setup", "write"] as const)(
    "preserves compiler outcomes when evidence %s fails",
    async (phase) => {
      const { cwd, directory, command } = fixture();
      if (phase === "write") {
        vi.mocked(runManagedCommand).mockResolvedValue(0);
        await runMeasuredTsgoCommand(command, directory);
        await runMeasuredTsgoCommand(command, directory);
        expect(fs.readdirSync(directory)).toHaveLength(2);
      }
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitCode = phase === "setup" ? 7 : 9;
      vi.mocked(runManagedCommand).mockImplementationOnce(async () => {
        if (phase === "write") {
          fs.rmSync(directory, { recursive: true });
        }
        return exitCode;
      });
      const calls = vi.mocked(runManagedCommand).mock.calls.length;
      expect(
        await runMeasuredTsgoCommand(
          command,
          phase === "setup" ? path.join(cwd, "package.json", "metrics") : directory,
        ),
      ).toBe(exitCode);
      expect(vi.mocked(runManagedCommand).mock.calls.length - calls).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          phase === "setup" ? "without metrics" : "compiler outcome preserved",
        ),
      );
    },
  );
});
