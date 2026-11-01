import { execFile } from "node:child_process";
import { pbkdf2Sync, scryptSync } from "node:crypto";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStallFlightRecorder } from "./diagnostic-stall-flight-recorder.js";

const native = vi.hoisted(() => ({
  start: vi.fn(),
  versions: { node: "26.6.0", bun: undefined as string | undefined },
  conflict: vi.fn(() => false),
  mainThread: true,
  kernel: vi.fn(),
}));
vi.mock("node:v8", async (original) => ({
  ...(await original<typeof import("node:v8")>()),
  startCpuProfile: native.start,
}));
vi.mock("node:process", async (original) => ({
  ...(await original<typeof import("node:process")>()),
  versions: native.versions,
}));
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  get isMainThread() {
    return native.mainThread;
  },
}));
vi.mock("./diagnostic-profile.js", async (original) => ({
  ...(await original<typeof import("./diagnostic-profile.js")>()),
  hasProfilerConflict: native.conflict,
}));
vi.mock("./diagnostic-stall-kernel.js", async (original) => ({
  ...(await original<typeof import("./diagnostic-stall-kernel.js")>()),
  createStallKernelRecorder: native.kernel,
}));

const recorders: ReturnType<typeof createStallFlightRecorder>[] = [];
const getBuiltinModule = process.getBuiltinModule.bind(process);
afterEach(() => {
  for (const recorder of recorders.splice(0)) {
    recorder.stop();
  }
  vi.restoreAllMocks();
});
beforeEach(() => {
  native.start.mockReset();
  native.conflict.mockReset().mockReturnValue(false);
  native.versions.node = "26.6.0";
  native.mainThread = true;
  native.kernel.mockReset();
  vi.spyOn(process, "getBuiltinModule").mockImplementation((id) =>
    id === "inspector"
      ? { url: () => undefined }
      : id === "trace_events"
        ? { getEnabledCategories: () => undefined }
        : getBuiltinModule(id),
  );
});

function profile(start: number, name: string, url = "node:timers", end = start + 1_500) {
  // Match V8's field order; the parser repairs unescaped strings in this shape.
  return `{"startTime":${start * 1_000},"endTime":${end * 1_000},"nodes":[
    {"id":1,"callFrame":{"functionName":"(root)","lineNumber":-1,"columnNumber":-1,"scriptId":0,"url":""},"children":[2]},
    {"id":2,"callFrame":{"functionName":${JSON.stringify(name)},"lineNumber":9,"columnNumber":0,"scriptId":1,"url":${JSON.stringify(url)}}}
  ],"samples":[2,2],"timeDeltas":[500000,1000000]}`;
}

function fixture(firstProfile?: string) {
  let time = 0;
  vi.spyOn(performance, "now").mockImplementation(() => time);
  const warn = vi.fn();
  const handles = [0, 1, 2].map((index) => ({
    stop: vi.fn(() => profile(index * 5_000, `work${index}`, "node:timers", time)),
    [Symbol.dispose]: vi.fn(),
  }));
  native.start.mockImplementation(() => handles[native.start.mock.calls.length - 1]);
  const recorder = createStallFlightRecorder(warn);
  if (firstProfile !== undefined) {
    handles[0]!.stop.mockReturnValue(firstProfile);
  }
  recorders.push(recorder);
  const sampleAt = (
    value: number,
    stall: { startedAt: number; endedAt: number; task?: string } | null = {
      startedAt: value - 1_500,
      endedAt: value,
    },
  ) => {
    time = value;
    return recorder.sample(stall ?? undefined);
  };
  return { recorder, handles, warn, sampleAt, elapse: (ms: number) => (time += ms) };
}
function capture(json: string) {
  const fixtureState = fixture(json);
  return { ...fixtureState, result: fixtureState.sampleAt(1_500) };
}
it("keeps live kernel evidence when sampled stacks exhaust the shared report budget", () => {
  const evidence = ` kernel=${JSON.stringify([{ state: "D", wchan: "filemap_fault", stack: "x".repeat(1_300) }])}`;
  native.kernel.mockReturnValue({ take: () => evidence, stop: vi.fn() });
  const { result } = capture(profile(0, "x".repeat(230)));
  expect(result).toContain(evidence);
  expect(result).toContain("reportTruncated=true");
  expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(2_048);
});
it("retains the recorded async task when the sampled stack ends in a dependency", () => {
  const dependencyUrl = new URL(
    "../../node_modules/@openclaw/fs-safe/dist/write.js",
    import.meta.url,
  ).href;
  const { sampleAt } = fixture(profile(0, "runPinnedWriteNative", dependencyUrl));
  const result = sampleAt(1_500, {
    startedAt: 0,
    endedAt: 1_500,
    task: "schema-store:write",
  });
  expect(result).toContain("[async task:schema-store:write]");
  expect(result).toContain("runPinnedWriteNative@node_modules/@openclaw/fs-safe");
  expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(2_048);
});

it.each([false, true])(
  "identifies sampled leaves below shared ancestors within the log cap (long=%s)",
  (long) => {
    const frame = (id: number, name: string, url: string, children?: number[]) => ({
      id,
      callFrame: { functionName: name, url, lineNumber: 9, columnNumber: 0, scriptId: 1 },
      children,
    });
    const appUrl = new URL("../agents/admitted-run-context.ts", import.meta.url).href;
    const dependencyUrl = new URL(
      "../../node_modules/@openclaw/fs-safe/dist/write.js",
      import.meta.url,
    ).href;
    const suffix = long ? "x".repeat(200) : "";
    const depth = long ? 24 : 12;
    const nodes = Array.from({ length: depth }, (_, i) =>
      frame(
        i,
        `shared${i}${suffix}`,
        i === 0 ? appUrl : dependencyUrl,
        i < depth - 1 ? [i + 1] : Array.from({ length: 12 }, (_leaf, j) => j + depth),
      ),
    );
    nodes.push(
      ...Array.from({ length: 12 }, (_, i) => frame(i + depth, `probe${i}${suffix}`, "node:fs")),
    );
    const { result, warn } = capture(
      JSON.stringify({
        startTime: 0,
        endTime: 1_500_000,
        nodes,
        samples: Array.from({ length: 12 }, (_, i) => i + depth),
        timeDeltas: Array.from({ length: 12 }, () => 100_000),
      }),
    );
    expect(warn).not.toHaveBeenCalled();
    expect(result).toContain("self=");
    const self = JSON.parse(result!.match(/ self=(.*) deepest=/)![1]!) as Array<
      [string, number, number, string]
    >;
    const deepest = JSON.parse(result!.split(" deepest=")[1]!) as Array<[number, string[]]>;
    expect(self[0]).toEqual([
      expect.stringContaining("probe0"),
      1,
      100,
      expect.stringContaining("shared0"),
    ]);
    expect(deepest[0]?.[1][0]).toContain("shared0");
    expect(deepest[0]?.[1].at(-1)).toContain("probe0");
    expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(2_048);
    if (long) {
      expect(result).toContain("reportTruncated=true");
      expect(deepest[0]?.[1]).toContain("[...]");
    }
  },
);
it("rotates without a sampling gap and reports only the recent stall's inclusive frames", () => {
  const { recorder, handles, sampleAt } = fixture();
  expect(sampleAt(5_000, null)).toBeUndefined();
  expect(native.start.mock.invocationCallOrder[1]).toBeLessThan(
    handles[0]!.stop.mock.invocationCallOrder[0]!,
  );
  const result = sampleAt(6_500);
  expect(result).toContain('inclusive=[["work1@node:timers:10",2]]');
  expect(result).toContain("samples=2 intervalMs=25 truncated=false");
  expect(result).not.toContain("work0");
  recorder.stop();
  expect(handles[2]![Symbol.dispose]).toHaveBeenCalledOnce();
  expect(sampleAt(12_000)).toBeUndefined();
  expect(native.start).toHaveBeenCalledTimes(3);
});

function sampledProfile(start: number, end: number, samples: Array<{ at: number; name: string }>) {
  // Native profile timestamps have a different origin from performance.now().
  const nativeOriginUs = 17_000_000;
  let previousAt = start;
  return JSON.stringify({
    startTime: nativeOriginUs + start * 1_000,
    endTime: nativeOriginUs + end * 1_000,
    nodes: samples.map(({ name }, index) => ({
      id: index + 1,
      callFrame: {
        functionName: name,
        lineNumber: 9,
        columnNumber: 0,
        scriptId: 1,
        url: "node:timers",
      },
    })),
    samples: samples.map((_, index) => index + 1),
    timeDeltas: samples.map(({ at }) => {
      const delta = (at - previousAt) * 1_000;
      previousAt = at;
      return delta;
    }),
  });
}

function sampleWindow(earlier: number[], block: number[], later: number[]) {
  return [earlier, block, later].flatMap((times, index) =>
    times.map((at) => ({ at, name: ["earlierWork", "controlledBlock", "laterWork"][index]! })),
  );
}

it.skipIf(typeof getBuiltinModule("v8").startCpuProfile !== "function")(
  "profiles a real 1,200 ms synchronous block without the unrelated work before its report",
  async () => {
    native.start.mockImplementation(getBuiltinModule("v8").startCpuProfile);
    const warn = vi.fn();
    const recorder = createStallFlightRecorder(warn);
    recorders.push(recorder);
    expect(native.start).toHaveBeenCalledOnce();
    // A timer gives the block its real runtime stack without the test runner's ancestors.
    const result = await new Promise<string | undefined>((resolve) => {
      setTimeout(() => {
        const startedAt = performance.now();
        while (performance.now() - startedAt < 1_200) {
          pbkdf2Sync("fixture", "fixture", 10_000, 32, "sha256");
        }
        const endedAt = performance.now();
        while (performance.now() - endedAt < 600) {
          scryptSync("fixture", "fixture", 32);
        }
        resolve(recorder.sample({ startedAt, endedAt }));
      }, 0);
    });
    expect(warn).not.toHaveBeenCalled();
    expect(result).toContain("pbkdf2Sync@node:internal/crypto/pbkdf2");
    expect(result).not.toContain("scryptSync");
  },
);

it.each([
  {
    name: "a delayed report",
    startedAt: 500,
    endedAt: 1_700,
    reportAt: 2_500,
    rotationAt: 0,
    serializationMs: 0,
    chunks: [sampleWindow([300], [525, 1_000, 1_675], [1_750, 2_300])],
    expectedSamples: 3,
  },
  {
    name: "retained chunks and slow serialization",
    startedAt: 4_400,
    endedAt: 5_600,
    reportAt: 6_500,
    rotationAt: 5_000,
    serializationMs: 50,
    chunks: [
      sampleWindow([4_200], [4_450, 4_900], []),
      sampleWindow([], [5_100, 5_575], [5_625, 6_100]),
    ],
    expectedSamples: 4,
  },
])("attributes the 1,200 ms block itself across $name", (testCase) => {
  const { handles, sampleAt, elapse } = fixture();
  for (const [index, samples] of testCase.chunks.entries()) {
    handles[index]!.stop.mockImplementation(() => {
      elapse(testCase.serializationMs);
      return sampledProfile(
        index === 0 ? 0 : testCase.rotationAt,
        index < testCase.chunks.length - 1 ? testCase.rotationAt : testCase.reportAt,
        samples,
      );
    });
  }
  if (testCase.rotationAt) {
    expect(sampleAt(testCase.rotationAt, null)).toBeUndefined();
  }
  const result = sampleAt(testCase.reportAt, {
    startedAt: testCase.startedAt,
    endedAt: testCase.endedAt,
  });
  expect(result).not.toContain("laterWork");
  expect(result).not.toContain("earlierWork");
  expect(result).toContain(
    `inclusive=[["controlledBlock@node:timers:10",${testCase.expectedSamples}]]`,
  );
  expect(result).toContain("windowMs=1200");
  expect(result).toContain(`samples=${testCase.expectedSamples} intervalMs=25 truncated=false`);
  expect(result).toContain(
    `windowStartMs=${Math.round(performance.timeOrigin + testCase.startedAt)}`,
  );
  expect(result).toContain(`windowEndMs=${Math.round(performance.timeOrigin + testCase.endedAt)}`);
  const reportTime = Number(result?.match(/reportedAtMs=(\d+)/)?.[1]);
  expect(reportTime).toBeGreaterThanOrEqual(Math.round(performance.timeOrigin + testCase.reportAt));
});

it.each([
  [
    "untrusted script",
    profile(0, "secretAccount", "file:///private/person/plugin.js"),
    "inclusive=[]",
  ],
  [
    "raw function name",
    profile(0, "placeholder").replace('"placeholder"', '"private"name\\with\ncontrols"'),
    'inclusive=[["[redacted]@node:timers:10",2]]',
  ],
])("redacts %s without losing safe frames", (_kind, json, expected) => {
  const { result, warn } = capture(json);
  expect(result).toContain(expected);
  expect(result).not.toMatch(/secretAccount|private|person/);
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  'quoted"file.js',
  String.raw`windows\file.js`,
  "line\nbreak.js",
  'json-{"key":"value"}-file.js',
])("keeps trusted caller attribution when native script names contain %j", (filename) => {
  // V8's native serializer writes these strings verbatim, without JSON escaping.
  const { result, warn, sampleAt } = capture(
    profile(0, "secretAccount")
      .replace('"functionName":"(root)"', '"functionName":"trustedCaller"')
      .replace('"url":"node:timers"', `"url":"file:///private/${filename}"`)
      .replace('"url":""', '"url":"node:timers"'),
  );
  expect(result).toContain('inclusive=[["trustedCaller@node:timers:0",2]]');
  expect(result).not.toMatch(/secretAccount|private|quoted|windows|break/);
  expect(warn).not.toHaveBeenCalled();
  expect(sampleAt(6_500)).toContain("work1@node:timers:10");
});

it("caps oversized windows and disables failed capture without failing the sampler", () => {
  const { recorder, handles, warn, result } = capture(" ".repeat(1_048_577));
  expect(result).toContain("truncated=true inclusive=[]");
  native.start.mockImplementation(() => {
    throw new Error("native failure");
  });
  expect(recorder.sample({ startedAt: 0, endedAt: 1_500 })).toBeUndefined();
  expect(warn).toHaveBeenCalledWith("stall flight recorder unavailable: profiler-capture-failed");
  expect(handles[1]![Symbol.dispose]).toHaveBeenCalledOnce();
  expect(recorder.sample({ startedAt: 0, endedAt: 1_500 })).toBeUndefined();
});

it.each(["runtime", "profiler", "worker"])(
  "leaves an unsupported or conflicting %s alone",
  (kind) => {
    native.versions.node = kind === "runtime" ? "24.19.0" : "26.6.0";
    native.conflict.mockReturnValue(kind === "profiler");
    native.mainThread = kind !== "worker";
    const { recorder } = fixture();
    expect(recorder.sample({ startedAt: 0, endedAt: 1_500 })).toBeUndefined();
    expect(native.start).not.toHaveBeenCalled();
  },
);

it.skipIf(
  process.platform !== "linux" ||
    Boolean(process.versions.bun) ||
    Number(process.versions.node.split(".")[0]) < 26,
)(
  "captures the main thread's live futex wait three times within the profile byte cap",
  async () => {
    // Vitest runs in a worker; a subprocess exercises the real main-thread recorder.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `
      import { createStallFlightRecorder } from ${JSON.stringify(new URL("./diagnostic-stall-flight-recorder.ts", import.meta.url).href)};
      let ready = Promise.resolve();
      process.once('worker', worker => {
        worker.ref();
        ready = new Promise(resolve => worker.once('online', () => { worker.unref(); resolve(); }));
      });
      const recorder = createStallFlightRecorder(message => { throw new Error(message); });
      try {
        await new Promise(setImmediate);
        await ready;
        const startedAt = performance.now();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3600);
        const endedAt = performance.now();
        console.log(recorder.sample({ startedAt, endedAt }));
      } finally { recorder.stop(); }
    `,
      ],
      { timeout: 12_000 },
    );
    const report = stdout.trim();
    expect(Buffer.byteLength(report)).toBeLessThanOrEqual(2_048);
    const samples = JSON.parse(report.match(/ kernel=(.*?) inclusive=/)![1]!) as Array<{
      at: number;
      state: string;
      wchan: string;
      syscall: string;
      io: number[];
      ctxt: number[];
    }>;
    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      expect(sample.state).toBe("S");
      expect(sample.wchan).toMatch(/futex/);
      expect(sample.syscall).toBe(process.arch === "arm64" ? "98" : "202");
      expect(sample.at).toBeGreaterThan(0);
      expect(sample.at).toBeLessThan(3_600);
      expect(sample.io).toHaveLength(7);
      expect(sample.ctxt).toHaveLength(2);
    }
  },
);
