import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStallFlightRecorder } from "./diagnostic-stall-flight-recorder.js";

const native = vi.hoisted(() => ({
  start: vi.fn(),
  versions: { node: "26.6.0", bun: undefined as string | undefined },
  conflict: vi.fn(() => false),
  mainThread: true,
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
  vi.spyOn(process, "getBuiltinModule").mockImplementation((id) =>
    id === "inspector"
      ? { url: () => undefined }
      : id === "trace_events"
        ? { getEnabledCategories: () => undefined }
        : getBuiltinModule(id),
  );
});

function profile(start: number, name: string, url = "node:timers") {
  return JSON.stringify({
    startTime: start * 1_000,
    endTime: (start + 1_500) * 1_000,
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          url: "",
          scriptId: 0,
          lineNumber: -1,
          columnNumber: -1,
        },
        children: [2],
      },
      {
        id: 2,
        callFrame: { functionName: name, url, scriptId: 1, lineNumber: 9, columnNumber: 0 },
      },
    ],
    samples: [2, 2],
    timeDeltas: [500_000, 1_000_000],
  });
}

function fixture() {
  let time = 0;
  const warn = vi.fn();
  const handles = [0, 1, 2].map((index) => ({
    stop: vi.fn(() =>
      JSON.stringify({
        ...JSON.parse(profile(index * 5_000, `work${index}`)),
        endTime: time * 1_000,
      }),
    ),
    [Symbol.dispose]: vi.fn(),
  }));
  native.start.mockImplementation(() => handles[native.start.mock.calls.length - 1]);
  const recorder = createStallFlightRecorder(warn, () => time);
  recorders.push(recorder);
  return { recorder, handles, warn, at: (value: number) => (time = value) };
}

describe("stall flight recorder", () => {
  it("rotates without a sampling gap and reports only the recent stall's inclusive frames", () => {
    const { recorder, handles, at } = fixture();
    at(5_000);
    expect(recorder.sample()).toBeUndefined();
    expect(native.start.mock.invocationCallOrder[1]).toBeLessThan(
      handles[0]!.stop.mock.invocationCallOrder[0]!,
    );
    at(6_500);
    const result = recorder.sample(1_500);
    expect(result).toContain('inclusive=[["work1@node:timers:10",2]]');
    expect(result).toContain("samples=2 intervalMs=10 truncated=false");
    expect(result).not.toContain("work0");
    recorder.stop();
    expect(handles[2]![Symbol.dispose]).toHaveBeenCalledOnce();
    at(12_000);
    expect(recorder.sample(1_500)).toBeUndefined();
    expect(native.start).toHaveBeenCalledTimes(3);
  });

  it("does not expose symbols or paths from untrusted script locations", () => {
    const { recorder, handles, at } = fixture();
    handles[0]!.stop.mockReturnValue(
      profile(0, "secretAccount", "file:///private/person/plugin.js"),
    );
    at(1_500);
    const result = recorder.sample(1_500);
    expect(result).toContain("inclusive=[]");
    expect(result).not.toMatch(/secretAccount|private|person/);
  });

  it("caps oversized windows and disables failed capture without failing the sampler", () => {
    const { recorder, handles, warn, at } = fixture();
    handles[0]!.stop.mockReturnValue(" ".repeat(1_048_577));
    at(1_500);
    expect(recorder.sample(1_500)).toContain("truncated=true inclusive=[]");
    native.start.mockImplementation(() => {
      throw new Error("native failure");
    });
    expect(recorder.sample(1_500)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("stall flight recorder unavailable: profiler-capture-failed");
    expect(handles[1]![Symbol.dispose]).toHaveBeenCalledOnce();
    expect(recorder.sample(1_500)).toBeUndefined();
  });

  it.each(["runtime", "profiler", "worker"])(
    "leaves an unsupported or conflicting %s alone",
    (kind) => {
      if (kind === "runtime") {
        native.versions.node = "24.19.0";
      } else if (kind === "profiler") {
        native.conflict.mockReturnValue(true);
      } else {
        native.mainThread = false;
      }
      const { recorder } = fixture();
      expect(recorder.sample(1_500)).toBeUndefined();
      expect(native.start).not.toHaveBeenCalled();
    },
  );
});
