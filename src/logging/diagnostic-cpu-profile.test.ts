import fs from "node:fs/promises";
import type { Profiler } from "node:inspector";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { diagnosticProfileEntrypoints } from "./diagnostic-profile-runtime.test-support.js";

const native = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  post: vi.fn(),
  url: vi.fn(),
  wait: vi.fn(),
  resolveRoot: vi.fn(),
  tracingCategories: vi.fn(),
  unsupported: false,
  start: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node")!;
vi.mock("node:v8", async (original) => ({
  ...(await original<typeof import("node:v8")>()),
  startCpuProfile: native.start,
}));
vi.mock("node:timers/promises", () => ({ setTimeout: native.wait }));
vi.mock("node:trace_events", () => ({ getEnabledCategories: native.tracingCategories }));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: native.resolveRoot,
}));

type ProfileFixture = Profiler.Profile & {
  nodes: [
    Profiler.ProfileNode & { children: number[] },
    Profiler.ProfileNode,
    Profiler.ProfileNode,
  ];
  samples: number[];
  timeDeltas: number[];
};

function profile(): ProfileFixture {
  return {
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: "0",
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        children: [2, 3],
      },
      {
        id: 2,
        callFrame: {
          functionName: "readRows",
          scriptId: "12",
          url: "/fixture/openclaw/src/state/read.js",
          lineNumber: 20,
          columnNumber: 4,
        },
        hitCount: 2,
        positionTicks: [{ line: 21, ticks: 2 }],
      },
      {
        id: 3,
        callFrame: {
          functionName: "private payload",
          scriptId: "14",
          url: "eval://private-source",
          lineNumber: 0,
          columnNumber: 0,
        },
        deoptReason: "private reason",
      },
    ],
    startTime: 10_000,
    endTime: 5_510_000,
    samples: [2, 3, 2],
    timeDeltas: [10_000, 11_000, 10_000],
  };
}

async function capture(
  signal = new AbortController().signal,
  hasAuthority = () => true,
  params: { windows?: number; windowMs?: number } = {},
) {
  const { captureDiagnosticCpuProfile } = await import("./diagnostic-cpu-profile.js");
  return captureDiagnosticCpuProfile({ ...params, signal, hasAuthority });
}

async function readArtifact(
  outcome: Awaited<ReturnType<typeof capture>>,
): Promise<Profiler.Profile> {
  assert(outcome.status === "complete" && "path" in outcome.result);
  const result = outcome.result;
  expect(result).not.toHaveProperty("profile");
  expect(path.dirname(result.path)).toBe(path.join(stateDir, "diagnostics"));
  expect(path.basename(result.path)).toMatch(/^cpu-.+\.cpuprofile$/);
  const content = await fs.readFile(result.path, "utf8");
  expect(Buffer.byteLength(content)).toBe(result.sizeBytes);
  expect(content).not.toMatch(/fixture|private/);
  if (process.platform !== "win32") {
    expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(result.path))).mode & 0o777).toBe(0o700);
  }
  return JSON.parse(content);
}

function returnProfile(value: Profiler.Profile = profile()) {
  native.post.mockImplementation(async (method: string) =>
    method === "Profiler.stop" ? { profile: value } : {},
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  stateDir = tempDirs.make("cpu-profile-artifact-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("NODE_V8_COVERAGE", "");
  vi.stubEnv("BUN_INSPECT", "");
  vi.stubEnv("BUN_INSPECT_CONNECT_TO", "");
  native.unsupported = false;
  Object.defineProperty(process.versions, "bun", { configurable: true, value: "fixture" });
  native.start.mockReturnValue({ stop: native.stop, [Symbol.dispose]: native.dispose });
  native.stop.mockReturnValue(
    JSON.stringify(profile()).replace(/"scriptId":"(\d+)"/g, '"scriptId":$1'),
  );
  vi.doMock("node:inspector/promises", () => {
    if (native.unsupported) {
      throw new Error("inspector unavailable");
    }
    return {
      url: native.url,
      Session: class {
        connect = native.connect;
        disconnect = native.disconnect;
        post = native.post;
      },
    };
  });
  native.resolveRoot.mockResolvedValue("/fixture/openclaw");
  returnProfile();
  native.wait.mockResolvedValue(undefined);
});
afterEach(() => {
  Object.defineProperty(process.versions, "node", nodeVersion);
  if (bunVersion) {
    Object.defineProperty(process.versions, "bun", bunVersion);
  } else {
    Reflect.deleteProperty(process.versions, "bun");
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("diagnostic CPU profile owner", () => {
  it.each(["24.22.1", "26.12.1"])(
    "returns contiguous batch windows without losing signed-delta samples on Node %s",
    async (version) => {
      Object.defineProperty(process.versions, "node", { configurable: true, value: version });
      Reflect.deleteProperty(process.versions, "bun");
      const value = {
        ...profile(),
        endTime: 3_110_000,
        samples: [2, 3, 2, 3, 2],
        timeDeltas: [1_000_000, -500, 500, 1_000_000, 1_000_000],
      };
      returnProfile(value);
      native.stop.mockReturnValue(JSON.stringify(value));
      native.wait.mockImplementationOnce(async () => {
        expect(await capture()).toMatchObject({ status: "unavailable", reason: "busy" });
      });
      const outcome = await capture(undefined, undefined, { windows: 3, windowMs: 1_000 });
      expect(outcome).toMatchObject({
        status: "complete",
        result: {
          requestedDurationMs: 3_000,
          windowBoundariesMicros: [10_000, 1_010_000, 2_010_000, 3_110_000],
          summary: { nodeCount: 3, sampleCount: 5 },
        },
      });
      const saved = await readArtifact(outcome);
      expect(saved.samples).toEqual(value.samples);
      expect(saved.timeDeltas).toEqual(value.timeDeltas);
      assert(outcome.status === "complete" && "windowBoundariesMicros" in outcome.result);
      const boundaries = outcome.result.windowBoundariesMicros!;
      let timestamp = saved.startTime;
      const timestamps = saved.timeDeltas!.map((delta) => (timestamp += delta));
      const counts = boundaries
        .slice(1)
        .map(
          (end, index) =>
            timestamps.filter(
              (at) =>
                at >= boundaries[index]! &&
                (at < end || (index === boundaries.length - 2 && at === end)),
            ).length,
        );
      expect(counts).toEqual([1, 2, 2]);
      expect(counts.reduce((total, count) => total + count, 0)).toBe(value.samples.length);
      expect(native.wait).toHaveBeenCalledExactlyOnceWith(3_000, undefined, {
        signal: expect.any(AbortSignal),
      });
      if (version.startsWith("24")) {
        expect(native.start).not.toHaveBeenCalled();
        expect(native.post.mock.calls.map(([method]) => method)).toEqual([
          "Profiler.enable",
          "Profiler.setSamplingInterval",
          "Profiler.start",
          "Profiler.stop",
          "Profiler.disable",
        ]);
        expect(native.post).toHaveBeenCalledWith("Profiler.setSamplingInterval", {
          interval: 10_000,
        });
      } else {
        expect(native.start).toHaveBeenCalledOnce();
        expect(native.stop).toHaveBeenCalledOnce();
      }
    },
  );
  it("preserves a large native graph while repairing names, URLs and signed script IDs", async () => {
    const { parseNativeCpuProfile } = await import("./diagnostic-profile.js");
    const nodes: Profiler.ProfileNode[] = Array.from({ length: 4_096 }, (_, index) => ({
      id: index + 1,
      hitCount: index % 3,
      callFrame: {
        functionName: `work${index}"\\\nlabel`,
        lineNumber: index - 2,
        columnNumber: -1,
        scriptId: String(index - 2),
        url: `file:///fixture/quoted"\\\nmodule${index}.js`,
      },
      ...(index < 4_095 ? { children: [index + 2] } : {}),
      ...(index % 2 === 0
        ? { deoptReason: "not optimized", positionTicks: [{ line: index, ticks: 2 }] }
        : {}),
    }));
    const expected: Profiler.Profile = {
      nodes,
      startTime: 10_000,
      endTime: 5_510_000,
      samples: [4_096, 2, 4_096],
      timeDeltas: [10_000, -500, 10_500],
    };
    // Match native field order and verbatim names/URLs, not JSON.stringify escaping.
    const json = JSON.stringify(expected)
      .replace(/"scriptId":"(-?\d+)"/g, '"scriptId":$1')
      .replace(
        /"(functionName|url)":("(?:\\.|[^"\\])*")/g,
        (_match, key, value) => `"${key}":"${JSON.parse(value)}"`,
      );
    expect(parseNativeCpuProfile(json)).toStrictEqual(expected);
  });

  it("reports disposal failure and allows a later native capture", async () => {
    Object.defineProperty(process.versions, "bun", { configurable: true, value: undefined });
    native.dispose.mockImplementationOnce(() => {
      throw new Error("private native failure");
    });
    expect(await capture()).toEqual({
      status: "unavailable",
      reason: "cleanup-failed",
      cleanupFailed: true,
    });
    expect(native.dispose).toHaveBeenCalledOnce();
    expect((await capture()).status).toBe("complete");
    expect(native.start).toHaveBeenCalledTimes(2);
  });
  it("reports elapsed capture time including native startup and stop completion", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    native.post.mockImplementation((method: string) => {
      if (method === "Profiler.start") {
        now += 2_100;
        return Promise.resolve().then(() => {
          now += 700;
          return {};
        });
      }
      now += 20;
      return Promise.resolve(method === "Profiler.stop" ? { profile: profile() } : {});
    });
    native.wait.mockImplementation(async () => {
      now += 5_000;
    });
    expect(await capture()).toMatchObject({
      status: "complete",
      result: { startBlockedMs: 2_100, actualDurationMs: 7_820 },
    });
  });
  it("returns a complete sanitized graph only after native cleanup", async () => {
    const outcome = await capture();
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") {
      throw new Error("capture failed");
    }
    expect(outcome.result).toMatchObject({
      requestedDurationMs: 5_000,
      samplingIntervalMicros: 10_000,
      sampleLossCount: null,
      redactedNodeCount: 1,
    });
    assert("profile" in outcome.result);
    await expect(fs.readdir(path.join(stateDir, "diagnostics"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(outcome.result.profile).toEqual({
      ...profile(),
      nodes: [
        profile().nodes[0],
        {
          ...profile().nodes[1],
          callFrame: { ...profile().nodes[1].callFrame, url: "openclaw:src/state/read.js" },
        },
        {
          ...profile().nodes[2],
          callFrame: { ...profile().nodes[2].callFrame, functionName: "[redacted]", url: "" },
          deoptReason: "[redacted]",
        },
      ],
    });
    expect(JSON.stringify(outcome)).not.toMatch(/fixture|private/);
    expect(native.post.mock.calls.map(([method]) => method)).toEqual([
      "Profiler.enable",
      "Profiler.setSamplingInterval",
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable",
    ]);
    expect(native.post).toHaveBeenCalledWith("Profiler.setSamplingInterval", { interval: 10_000 });
    expect(native.wait).toHaveBeenCalledWith(5_000, undefined, { signal: expect.any(AbortSignal) });
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect((await capture()).status).toBe("complete");
  });

  it("preserves native signed script IDs, source offsets and sample order", async () => {
    const value = profile();
    value.timeDeltas = [10_000, -500, 10_500];
    value.nodes[1].callFrame.lineNumber = -10;
    value.nodes[1].callFrame.columnNumber = -200;
    value.nodes[1].positionTicks = [{ line: -9, ticks: 2 }];
    value.nodes[2].callFrame = {
      functionName: "wasm-to-js",
      scriptId: "-1",
      url: "",
      lineNumber: 0,
      columnNumber: 0,
    };
    returnProfile(value);
    expect(await capture()).toMatchObject({
      status: "complete",
      result: {
        profile: {
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 2,
              callFrame: expect.objectContaining({ lineNumber: -10, columnNumber: -200 }),
              positionTicks: [{ line: -9, ticks: 2 }],
            }),
            expect.objectContaining({
              id: 3,
              callFrame: {
                functionName: "[redacted]",
                scriptId: "-1",
                url: "",
                lineNumber: 0,
                columnNumber: 0,
              },
            }),
          ]),
          samples: [2, 3, 2],
          timeDeltas: [10_000, -500, 10_500],
        },
      },
    });
  });

  it.each(["-1.5", `-${"1".repeat(33)}`])(
    "rejects malformed or oversized script IDs: %s",
    async (scriptId) => {
      const value = profile();
      value.nodes[1].callFrame.scriptId = scriptId;
      returnProfile(value);
      expect(await capture()).toEqual({
        status: "unavailable",
        reason: "invalid-profile",
        cleanupFailed: false,
      });
      expect(native.disconnect).toHaveBeenCalledOnce();
    },
  );

  it.each(["authority-after-import", "authority-before-start"])(
    "does not start after %s",
    async (boundary) => {
      const controller = new AbortController();
      let authority = true;
      if (boundary === "authority-after-import") {
        native.resolveRoot.mockImplementation(async () => {
          authority = false;
          return "/fixture/openclaw";
        });
      } else {
        native.post.mockImplementation(async (method) => {
          if (method === "Profiler.setSamplingInterval") {
            authority = false;
          }
          return {};
        });
      }
      expect(await capture(controller.signal, () => authority)).toMatchObject({
        status: "unavailable",
        reason: "cancelled",
      });
      expect(native.post.mock.calls.some(([method]) => method === "Profiler.start")).toBe(false);
      expect(native.disconnect).toHaveBeenCalledTimes(
        boundary === "authority-before-start" ? 1 : 0,
      );
    },
  );

  it.each(["Profiler.start", "Profiler.disable"])(
    "releases native ownership when %s fails",
    async (failedMethod) => {
      native.post.mockImplementation(async (method) => {
        if (method === failedMethod) {
          throw new Error("private native error");
        }
        return method === "Profiler.stop" ? { profile: profile() } : {};
      });
      const outcome = await capture();
      expect(outcome).toEqual({
        status: "unavailable",
        reason: failedMethod === "Profiler.disable" ? "cleanup-failed" : "capture-failed",
        cleanupFailed: failedMethod === "Profiler.disable",
      });
      expect(JSON.stringify(outcome)).not.toContain("private");
      expect(native.disconnect).toHaveBeenCalledOnce();
      expect(
        native.post.mock.calls.filter(([method]) => method === "Profiler.stop").length,
      ).toBeLessThanOrEqual(1);
      returnProfile();
      expect((await capture()).status).toBe("complete");
    },
  );

  it("reports disconnect failure and allows a later inspector capture", async () => {
    native.post.mockRejectedValue(new Error("private native error"));
    native.disconnect.mockImplementationOnce(() => {
      throw new Error("private disconnect error");
    });
    expect(await capture()).toEqual({
      status: "unavailable",
      reason: "capture-failed",
      cleanupFailed: true,
    });
    returnProfile();
    expect((await capture()).status).toBe("complete");
    expect(native.connect).toHaveBeenCalledTimes(2);
  });

  it.each([
    "--inspect=0",
    "--cpu-prof",
    "--heap_prof",
    "--prof",
    "--perf-basic-prof",
    "--experimental-test-coverage",
  ])("refuses known profiler option %s", async (option) => {
    vi.stubEnv("NODE_OPTIONS", option);
    expect(await capture()).toMatchObject({ status: "unavailable", reason: "conflict" });
    expect(native.connect).not.toHaveBeenCalled();
  });

  it.each(["listener", "coverage", "malformed-options"])("refuses %s ownership", async (kind) => {
    if (kind === "listener") {
      native.url.mockReturnValue("ws://127.0.0.1:9229/fixture");
    }
    if (kind === "coverage") {
      vi.stubEnv("NODE_V8_COVERAGE", "fixture-coverage");
    }
    if (kind === "malformed-options") {
      vi.stubEnv("NODE_OPTIONS", '"unterminated');
    }
    expect(await capture()).toMatchObject({ status: "unavailable", reason: "conflict" });
    expect(native.connect).not.toHaveBeenCalled();
  });

  it("fails visibly when the runtime cannot load inspector", async () => {
    native.unsupported = true;
    expect(await capture()).toMatchObject({ status: "unavailable", reason: "unsupported" });
    expect(native.connect).not.toHaveBeenCalled();
  });

  it("rechecks tracing after awaited setup and before starting the profiler", async () => {
    native.post.mockImplementation(async (method) => {
      if (method === "Profiler.setSamplingInterval") {
        native.tracingCategories.mockReturnValue("disabled-by-default-v8.cpu_profiler");
      }
      return {};
    });
    expect(await capture()).toEqual({
      status: "unavailable",
      reason: "tracing-active",
      cleanupFailed: false,
    });
    expect(native.post.mock.calls.some(([method]) => method === "Profiler.start")).toBe(false);
    expect(native.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["BUN_INSPECT", "BUN_INSPECT_CONNECT_TO"])(
    "refuses %s debugger ownership on Bun only",
    async (variable) => {
      const original = Object.getOwnPropertyDescriptor(process.versions, "bun");
      try {
        vi.stubEnv(variable, "ws://127.0.0.1:9229/fixture");
        Object.defineProperty(process.versions, "bun", { configurable: true, value: "fixture" });
        expect(await capture()).toMatchObject({ status: "unavailable", reason: "conflict" });
        expect(native.connect).not.toHaveBeenCalled();
        Object.defineProperty(process.versions, "bun", { configurable: true, value: undefined });
        expect(await capture()).toMatchObject({ status: "complete" });
        expect(native.connect).not.toHaveBeenCalled();
      } finally {
        if (original) {
          Object.defineProperty(process.versions, "bun", original);
        } else {
          Reflect.deleteProperty(process.versions, "bun");
        }
      }
    },
  );

  it.each(["private payload", "会話の内容"])(
    "redacts unrecognized labels even at package code locations: %s",
    async (functionName) => {
      const value = profile();
      value.nodes[1].callFrame.functionName = functionName;
      returnProfile(value);
      const outcome = await capture();
      expect(outcome.status).toBe("complete");
      if (outcome.status === "complete" && "profile" in outcome.result && outcome.result.profile) {
        expect(outcome.result.profile.nodes[1]?.callFrame).toEqual({
          ...value.nodes[1].callFrame,
          functionName: "[redacted]",
          url: "openclaw:src/state/read.js",
        });
        expect(outcome.result.profile.samples).toEqual(value.samples);
        expect(outcome.result.profile.timeDeltas).toEqual(value.timeDeltas);
      }
      expect(JSON.stringify(outcome)).not.toContain(functionName);
    },
  );

  const invalidProfiles: Record<string, (value: ProfileFixture) => void> = {
    "fractional source line": (value) => {
      value.nodes[1].callFrame.lineNumber = -1.5;
    },
    "fractional source column": (value) => {
      value.nodes[1].callFrame.columnNumber = -1.5;
    },
  };
  it.each(Object.entries(invalidProfiles))(
    "rejects %s without publishing a partial graph",
    async (_name, mutate) => {
      const value = profile();
      mutate(value);
      returnProfile(value);
      expect(await capture()).toMatchObject({ status: "unavailable", reason: "invalid-profile" });
      expect(native.disconnect).toHaveBeenCalledOnce();
    },
  );

  it("persists an oversized profile without losing zero-hit samples or exposing labels", async () => {
    const value = profile();
    const nodes: Profiler.ProfileNode[] = Array.from({ length: 3_000 }, (_, index) => ({
      ...value.nodes[1],
      id: index + 1,
      hitCount: 0,
      callFrame: { ...value.nodes[1].callFrame, functionName: "x".repeat(256) },
    }));
    nodes[0] = { ...nodes[0]!, children: nodes.slice(1).map((node) => node.id) };
    nodes[2]!.callFrame.functionName = "private payload";
    returnProfile({ ...value, nodes });
    const outcome = await capture();
    const saved = await readArtifact(outcome);
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeGreaterThan(1024 * 1024);
    expect(saved.nodes).toHaveLength(3_000);
    expect(saved.nodes[2]?.callFrame.functionName).toBe("[redacted]");
    expect(saved.nodes[2]?.hitCount).toBe(0);
    expect(saved.samples).toEqual(value.samples);
    expect(saved.timeDeltas).toEqual(value.timeDeltas);
    expect(outcome).toMatchObject({ result: { summary: { nodeCount: 3_000, sampleCount: 3 } } });
    expect(native.disconnect).toHaveBeenCalledOnce();
  });

  it.each([8, 12])(
    "attributes identical %i-frame dependency stacks to their nearest application callers",
    async (dependencyDepth) => {
      const value = profile();
      const nodes: Profiler.ProfileNode[] = [{ ...value.nodes[0], children: [] }];
      const samples: number[] = [];
      for (const [index, url] of ["src/first.ts", "dist/second.js"].entries()) {
        let parent = nodes[0]!;
        const frames = [
          { ...value.nodes[1].callFrame, functionName: "runBoot" },
          {
            ...value.nodes[1].callFrame,
            functionName: "parseInput",
            url: `/fixture/openclaw/${url}`,
          },
          value.nodes[2].callFrame,
          ...Array.from({ length: dependencyDepth }, () => ({
            ...value.nodes[1].callFrame,
            functionName: "parse",
            url: "/fixture/openclaw/node_modules/@babel/parser/lib/index.js",
          })),
        ];
        for (const callFrame of frames) {
          const node: Profiler.ProfileNode = { id: nodes.length + 1, callFrame };
          (parent.children ??= []).push(node.id);
          nodes.push(node);
          parent = node;
        }
        samples.push(...Array<number>(index + 1).fill(parent.id));
      }
      // Unsampled code can make the native graph exceed the response limit.
      for (let index = 0; index < 3_000; index++) {
        const id = nodes.length + 1;
        nodes[0]!.children!.push(id);
        nodes.push({
          id,
          callFrame: { ...value.nodes[1].callFrame, functionName: "x".repeat(256) },
        });
      }
      const { sanitizeDiagnosticCpuProfile } = await import("./diagnostic-cpu-profile.js");
      const result = sanitizeDiagnosticCpuProfile(
        { ...value, nodes, samples, timeDeltas: samples.map(() => 10_000) },
        "/fixture/openclaw",
        { durationMs: 5_000, startBlockedMs: 0 },
      );
      assert("summary" in result);
      expect(result.summary).toEqual(
        ["dist/second.js", "src/first.ts"].map((url, index) => ({
          sampleCount: 2 - index,
          elidedFrameCount: dependencyDepth - 8 + 1,
          stack: [
            ...Array.from({ length: 8 }, () =>
              expect.objectContaining({ functionName: "[dep:@babel/parser]" }),
            ),
            expect.objectContaining({ functionName: "parseInput", url: `openclaw:${url}` }),
          ],
        })),
      );
      expect(result.omittedSampleCount).toBe(0);
      expect(JSON.stringify(result)).not.toMatch(/fixture|private|runBoot/);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024);
    },
  );

  it.each([
    { pathLength: 120, stackDepth: 30 },
    { pathLength: 1_100, stackDepth: 8 },
  ])(
    "bounds ranked summaries with $pathLength-character code paths",
    async ({ pathLength, stackDepth }) => {
      const value = profile();
      const nodes: Profiler.ProfileNode[] = [{ ...value.nodes[0], children: [] }];
      const samples: number[] = [];
      for (let branch = 0; branch < 200; branch++) {
        let parent = nodes[0]!;
        for (let depth = 0; depth < stackDepth; depth++) {
          const node: Profiler.ProfileNode = {
            id: nodes.length + 1,
            callFrame: {
              ...value.nodes[1].callFrame,
              scriptId: String(branch + 1),
              url: `/fixture/openclaw/src/${"x".repeat(pathLength)}.js`,
            },
          };
          (parent.children ??= []).push(node.id);
          nodes.push(node);
          parent = node;
        }
        samples.push(parent.id);
      }
      // The hottest stack is last in native order; ranking must retain it first.
      samples.push(...Array<number>(20).fill(samples.at(-1)!));
      const { sanitizeDiagnosticCpuProfile } = await import("./diagnostic-cpu-profile.js");
      const result = sanitizeDiagnosticCpuProfile(
        { ...value, nodes, samples, timeDeltas: samples.map(() => 10_000) },
        "/fixture/openclaw",
        { durationMs: 5_000, startBlockedMs: 0 },
      );
      assert("summary" in result);
      expect(result.profile).toBeUndefined();
      expect(result.summary[0]).toMatchObject({ sampleCount: 21 });
      expect(result.summary.every((row) => row.stack.length === 8)).toBe(true);
      expect(result.summary.length).toBeLessThanOrEqual(128);
      expect(result.summary.length).toBeGreaterThan(0);
      expect(result.omittedSampleCount).toBeGreaterThan(0);
      expect(
        result.summary.reduce((sum, row) => sum + row.sampleCount, result.omittedSampleCount),
      ).toBe(220);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024 * 1024);
    },
  );

  it.each(["nodes", "samples"] as const)(
    "persists the complete graph above the inline %s limit",
    async (limit) => {
      const value: Profiler.Profile = profile();
      if (limit === "nodes") {
        value.nodes = Array.from({ length: 16_385 }, (_, index) => ({
          ...profile().nodes[1],
          id: index + 1,
          ...(index < 16_384 ? { children: [index + 2] } : {}),
        }));
      } else {
        value.samples = Array<number>(65_537).fill(2);
        value.timeDeltas = value.samples.map(() => 10_000);
        value.endTime = value.startTime + value.samples.length * 10_000;
      }
      returnProfile(value);
      const saved = await readArtifact(await capture());
      expect(saved.nodes.map(({ id, children }) => ({ id, children }))).toEqual(
        value.nodes.map(({ id, children }) => ({ id, children })),
      );
      expect(saved.samples).toEqual(value.samples);
      expect(saved.timeDeltas).toEqual(value.timeDeltas);
    },
  );

  it("refuses files above 64 MiB and removes the partial artifact", async () => {
    const value = profile();
    const positionTicks = Array.from({ length: 40_000 }, (_, line) => ({ line, ticks: 1 }));
    returnProfile({
      ...value,
      nodes: Array.from({ length: 80 }, (_, index) => ({
        id: index + 1,
        callFrame: value.nodes[1].callFrame,
        positionTicks,
        ...(index < 79 ? { children: [index + 2] } : {}),
      })),
    });
    expect(await capture(undefined, undefined, { windows: 1 })).toMatchObject({
      status: "unavailable",
      reason: "profile-too-large",
      cleanupFailed: false,
    });
    expect(await fs.readdir(path.join(stateDir, "diagnostics"))).toEqual([]);
    expect(native.post.mock.calls.filter(([method]) => method === "Profiler.start")).toHaveLength(
      1,
    );
  });

  it.each(["disk budget", "unwritable destination"])(
    "refuses a batch with %s before starting the profiler",
    async (failure) => {
      if (failure === "disk budget") {
        const space = await fs.statfs(stateDir);
        space.bsize = 4096;
        space.bavail = 16_383;
        vi.spyOn(fs, "statfs").mockResolvedValue(space);
      } else {
        await fs.writeFile(path.join(stateDir, "diagnostics"), "not a directory");
      }
      expect(await capture(undefined, undefined, { windows: 12 })).toMatchObject({
        status: "unavailable",
        reason: failure === "disk budget" ? "insufficient-disk-space" : "capture-failed",
      });
      expect(native.start).not.toHaveBeenCalled();
      expect(native.post.mock.calls.some(([method]) => method === "Profiler.start")).toBe(false);
      if (failure === "disk budget") {
        expect(await fs.readdir(path.join(stateDir, "diagnostics"))).toEqual([]);
      }
    },
  );

  it.each(["abort", "authority", "write failure"])(
    "retains busy ownership and removes partial output after %s during artifact writing",
    async (failure) => {
      const controller = new AbortController();
      let authority = true;
      const open = fs.open.bind(fs);
      let writes = 0;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const file = await open(...args);
        const write = file.writeFile.bind(file);
        vi.spyOn(file, "writeFile").mockImplementation(async (...writeArgs) => {
          writes++;
          await write(...writeArgs);
          expect(await capture()).toMatchObject({ status: "unavailable", reason: "busy" });
          if (failure === "abort") {
            controller.abort();
          } else if (failure === "authority") {
            authority = false;
          } else {
            throw new Error("synthetic write failure");
          }
        });
        return file;
      });
      expect(await capture(controller.signal, () => authority, { windows: 1 })).toMatchObject({
        status: "unavailable",
        reason: failure === "write failure" ? "capture-failed" : "cancelled",
        cleanupFailed: false,
      });
      expect(writes).toBeGreaterThan(0);
      expect(await fs.readdir(path.join(stateDir, "diagnostics"))).toEqual([]);
      expect(native.disconnect).toHaveBeenCalledOnce();
      expect((await capture()).status).toBe("complete");
    },
  );

  it.skipIf(process.platform === "win32")(
    "captures a real profile with the current runtime without opening a listener",
    async ({ signal }) => {
      if (bunVersion) {
        Object.defineProperty(process.versions, "bun", bunVersion);
      } else {
        Reflect.deleteProperty(process.versions, "bun");
      }
      // Keep V8 coverage and mocked inspector/timers in the test worker. The
      // fresh child exercises the prepared owner without inheriting either.
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "HOME", "OPENCLAW_STATE_DIR", "TMPDIR", "TMP", "TEMP"]) {
        if (process.env[key]) {
          env[key] = process.env[key];
        }
      }
      const ownerUrl = resolveRuntimeWorkerUrl(diagnosticProfileEntrypoints.cpu);
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const source = `
import assert from 'node:assert/strict';
import { url } from 'node:inspector/promises';
import { captureDiagnosticCpuProfile } from ${JSON.stringify(ownerUrl.href)};
assert.equal(url(), undefined);
assert.equal(process.versions.bun ?? null, ${JSON.stringify(bunVersion?.value ?? null)});
const pid = process.pid;
const outcome = await captureDiagnosticCpuProfile({ signal: new AbortController().signal, hasAuthority: () => true });
assert.equal(outcome.status, 'complete', JSON.stringify(outcome));
const result = outcome.result;
assert.ok(result.actualDurationMs >= result.requestedDurationMs - 1_000);
assert.ok(result.profile.samples.length > 0);
assert.equal(result.profile.samples.length, result.profile.timeDeltas.length);
assert.ok(result.profile.timeDeltas.every(delta => Number.isFinite(delta)));
const ids = new Set(result.profile.nodes.map(node => node.id));
assert.ok(result.profile.samples.every(id => ids.has(id)));
assert.equal(result.sampleLossCount, null);
assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
assert.ok(!JSON.stringify(result).includes(${JSON.stringify(root)}));
assert.equal(url(), undefined);
assert.equal(process.pid, pid);
console.log(JSON.stringify({ node: process.version, bun: process.versions.bun ?? null, platform: process.platform, arch: process.arch, actualDurationMs: result.actualDurationMs, samples: result.profile.samples.length, nodes: result.profile.nodes.length, listener: false }));
`;
      const result = await runNodeScript(
        (workerArgv) => [
          ...workerArgv(ownerUrl).slice(0, -1),
          "--input-type=module",
          "--eval",
          source,
        ],
        env,
        20_000,
        {
          cwd: root,
          signal,
          maxBuffer: 32_768,
          requireProcessTreeExit: true,
          executable: process.execPath,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(result.stdout.trim());
      expect(receipt).toMatchObject({
        listener: false,
        samples: expect.any(Number),
        nodes: expect.any(Number),
        actualDurationMs: expect.any(Number),
      });
      console.log("CPU_PROFILE_NATIVE", JSON.stringify(receipt));
    },
    40_000,
  );
});
