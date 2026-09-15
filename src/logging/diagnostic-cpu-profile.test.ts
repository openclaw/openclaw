import type { Profiler } from "node:inspector";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

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

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("NODE_V8_COVERAGE", "");
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
  native.post.mockImplementation(async (method: string) =>
    method === "Profiler.stop" ? { profile: profile() } : {},
  );
  native.wait.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("diagnostic CPU profile owner", () => {
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

  it("rejects overlap instead of queuing, and stops on cancellation", async () => {
    const controller = new AbortController();
    const waiting = createDeferred();
    native.wait.mockImplementationOnce((_ms, _value, { signal }: { signal: AbortSignal }) => {
      waiting.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("fixture cancelled")), {
          once: true,
        });
      });
    });
    const active = capture(controller.signal);
    await waiting.promise;
    expect(await capture()).toEqual({
      status: "unavailable",
      reason: "busy",
      cleanupFailed: false,
    });
    controller.abort();
    expect(await active).toEqual({
      status: "unavailable",
      reason: "cancelled",
      cleanupFailed: false,
    });
    expect(native.post.mock.calls.filter(([method]) => method === "Profiler.stop")).toHaveLength(1);
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect((await capture()).status).toBe("complete");
  });

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

  it.each([
    "Profiler.enable",
    "Profiler.setSamplingInterval",
    "Profiler.start",
    "Profiler.stop",
    "Profiler.disable",
  ])("releases native ownership when %s fails", async (failedMethod) => {
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
    native.post.mockImplementation(async (method) =>
      method === "Profiler.stop" ? { profile: profile() } : {},
    );
    expect((await capture()).status).toBe("complete");
  });

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

  it.each([
    [
      "CLI CPU tracing",
      "node,disabled-by-default-v8.cpu_profiler",
      "--trace-event-categories=disabled-by-default-v8.cpu_profiler",
    ],
    ["programmatic CPU tracing", "disabled-by-default-v8.cpu_profiler", ""],
    ["non-CPU tracing", "node.perf", ""],
    ["wildcard tracing", "*", ""],
  ])("refuses the active category union for %s", async (_name, categories, nodeOptions) => {
    vi.stubEnv("NODE_OPTIONS", nodeOptions);
    native.tracingCategories.mockReturnValue(categories);
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

  it("rejects Bun without attempting to connect a native session", async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, "bun");
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "fixture" });
    try {
      expect(await capture()).toMatchObject({ status: "unavailable", reason: "unsupported" });
      expect(native.connect).not.toHaveBeenCalled();
    } finally {
      if (original) {
        Object.defineProperty(process.versions, "bun", original);
      } else {
        Reflect.deleteProperty(process.versions, "bun");
      }
    }
  });

  it.each(["private payload", "token:private", "<private>", "private[content]", "会話の内容"])(
    "redacts unrecognized labels even at package code locations: %s",
    async (functionName) => {
      const value = profile();
      value.nodes[1].callFrame.functionName = functionName;
      native.post.mockImplementation(async (method) =>
        method === "Profiler.stop" ? { profile: value } : {},
      );
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

  it.each([
    [
      "unknown sample",
      (value: ProfileFixture) => {
        value.samples[0] = 99;
      },
    ],
    [
      "missing delta",
      (value: ProfileFixture) => {
        value.timeDeltas.pop();
      },
    ],
    [
      "invalid delta",
      (value: ProfileFixture) => {
        value.timeDeltas[0] = Number.NaN;
      },
    ],
    [
      "duplicate node",
      (value: ProfileFixture) => {
        value.nodes[1].id = 1;
      },
    ],
    [
      "unknown child",
      (value: ProfileFixture) => {
        value.nodes[0].children.push(99);
      },
    ],
    [
      "cycle",
      (value: ProfileFixture) => {
        value.nodes[1].children = [1];
      },
    ],
    [
      "disconnected cycle",
      (value: ProfileFixture) => {
        value.nodes[0].children = [];
        value.nodes[1].children = [3];
        value.nodes[2].children = [2];
      },
    ],
  ] as const)("rejects %s without publishing a partial graph", async (_name, mutate) => {
    const value = profile();
    mutate(value);
    native.post.mockImplementation(async (method) =>
      method === "Profiler.stop" ? { profile: value } : {},
    );
    expect(await capture()).toMatchObject({ status: "unavailable", reason: "invalid-profile" });
    expect(native.disconnect).toHaveBeenCalledOnce();
  });

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
    native.post.mockImplementation(async (method) =>
      method === "Profiler.stop" ? { profile: value } : {},
    );
    expect(await capture()).toEqual({
      status: "unavailable",
      reason: "profile-too-large",
      cleanupFailed: false,
    });
    expect(native.disconnect).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
    "captures a real Node profile in an isolated child without opening a listener",
    async ({ signal }) => {
      // Keep V8 coverage and mocked inspector/timers in the test worker. The
      // fresh child exercises the actual owner with only the repo's TS loader.
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "TMPDIR", "TMP", "TEMP"]) {
        if (process.env[key]) {
          env[key] = process.env[key];
        }
      }
      const ownerUrl = new URL("./diagnostic-cpu-profile.ts", import.meta.url).href;
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const source = `
import assert from 'node:assert/strict';
import { url } from 'node:inspector/promises';
import { captureDiagnosticCpuProfile } from ${JSON.stringify(ownerUrl)};
assert.equal(url(), undefined);
const pid = process.pid;
const outcome = await captureDiagnosticCpuProfile({ signal: new AbortController().signal, hasAuthority: () => true });
assert.equal(outcome.status, 'complete', JSON.stringify(outcome));
const result = outcome.result;
assert.ok(result.actualDurationMs > 0);
assert.ok(result.profile.samples.length > 0);
assert.equal(result.profile.samples.length, result.profile.timeDeltas.length);
assert.ok(result.profile.timeDeltas.every(delta => Number.isFinite(delta) && delta >= 0));
const ids = new Set(result.profile.nodes.map(node => node.id));
assert.ok(result.profile.samples.every(id => ids.has(id)));
assert.equal(result.sampleLossCount, null);
assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
assert.ok(!JSON.stringify(result).includes(${JSON.stringify(root)}));
assert.equal(url(), undefined);
assert.equal(process.pid, pid);
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, actualDurationMs: result.actualDurationMs, samples: result.profile.samples.length, nodes: result.profile.nodes.length, listener: false }));
`;
      const result = await runNodeScript(
        [
          "--import",
          fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
          "--input-type=module",
          "--eval",
          source,
        ],
        env,
        20_000,
        { cwd: root, signal, maxBuffer: 32_768, requireProcessTreeExit: true },
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
