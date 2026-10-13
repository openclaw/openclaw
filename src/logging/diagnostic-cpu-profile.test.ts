import type { Profiler } from "node:inspector";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
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

async function capture(signal = new AbortController().signal, hasAuthority = () => true) {
  const { captureDiagnosticCpuProfile } = await import("./diagnostic-cpu-profile.js");
  return captureDiagnosticCpuProfile({ signal, hasAuthority });
}

function returnProfile(value: Profiler.Profile = profile()) {
  native.post.mockImplementation(async (method: string) =>
    method === "Profiler.stop" ? { profile: value } : {},
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("NODE_V8_COVERAGE", "");
  vi.stubEnv("BUN_INSPECT", "");
  vi.stubEnv("BUN_INSPECT_CONNECT_TO", "");
  native.unsupported = false;
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("diagnostic CPU profile owner", () => {
  it("reports synchronous start blocking separately from awaited capture time", async () => {
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
      result: { startBlockedMs: 2_100, actualDurationMs: 5_500 },
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
      actualDurationMs: 5_500,
      samplingIntervalMicros: 10_000,
      sampleLossCount: null,
      redactedNodeCount: 1,
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

  it.each(["pre-abort", "authority-after-import", "authority-before-start"])(
    "does not start after %s",
    async (boundary) => {
      const controller = new AbortController();
      let authority = true;
      if (boundary === "pre-abort") {
        controller.abort();
      } else if (boundary === "authority-after-import") {
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

  it.each(["Profiler.setSamplingInterval", "Profiler.start", "Profiler.stop", "Profiler.disable"])(
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

  it("preserves the capture failure and refuses reuse when disconnect fails", async () => {
    native.post.mockRejectedValue(new Error("private native error"));
    native.disconnect.mockImplementation(() => {
      throw new Error("private disconnect error");
    });
    expect(await capture()).toEqual({
      status: "unavailable",
      reason: "capture-failed",
      cleanupFailed: true,
    });
    expect(await capture()).toEqual({
      status: "unavailable",
      reason: "cleanup-failed",
      cleanupFailed: true,
    });
    expect(native.connect).toHaveBeenCalledOnce();
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

  it("refuses active tracing even for non-CPU categories", async () => {
    native.tracingCategories.mockReturnValue("node.perf");
    expect(await capture()).toEqual({
      status: "unavailable",
      reason: "tracing-active",
      cleanupFailed: false,
    });
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
        expect(native.connect).toHaveBeenCalledOnce();
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
      if (outcome.status === "complete") {
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
    "unknown sample": (value) => {
      value.samples[0] = 99;
    },
    "missing delta": (value) => {
      value.timeDeltas.pop();
    },
    "invalid delta": (value) => {
      value.timeDeltas[0] = Number.NaN;
    },
    "fractional source line": (value) => {
      value.nodes[1].callFrame.lineNumber = -1.5;
    },
    "fractional source column": (value) => {
      value.nodes[1].callFrame.columnNumber = -1.5;
    },
    "fractional position-tick line": (value) => {
      value.nodes[1].positionTicks = [{ line: -1.5, ticks: 2 }];
    },
    "duplicate node": (value) => {
      value.nodes[1].id = 1;
    },
    "unknown child": (value) => {
      value.nodes[0].children.push(99);
    },
    cycle: (value) => {
      value.nodes[1].children = [1];
    },
    "disconnected cycle": (value) => {
      value.nodes[0].children = [];
      value.nodes[1].children = [3];
      value.nodes[2].children = [2];
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

  it("rejects a complete result larger than 1 MiB without truncation", async () => {
    const template = profile().nodes[1];
    const root: Profiler.ProfileNode = {
      ...template,
      id: 1,
      callFrame: { ...template.callFrame, functionName: "x".repeat(256) },
    };
    const children = Array.from({ length: 2_999 }, (_, index) => ({ ...root, id: index + 2 }));
    root.children = children.map((node) => node.id);
    const value: Profiler.Profile = { ...profile(), nodes: [root, ...children] };
    returnProfile(value);
    expect(await capture()).toEqual({
      status: "unavailable",
      reason: "profile-too-large",
      cleanupFailed: false,
    });
    expect(native.disconnect).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")(
    "captures a real profile with the current runtime without opening a listener",
    async ({ signal }) => {
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
assert.equal(process.versions.bun ?? null, ${JSON.stringify(process.versions.bun ?? null)});
const pid = process.pid;
const outcome = await captureDiagnosticCpuProfile({ signal: new AbortController().signal, hasAuthority: () => true });
assert.equal(outcome.status, 'complete', JSON.stringify(outcome));
const result = outcome.result;
assert.ok(result.actualDurationMs > 0);
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
