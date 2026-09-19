import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

const hostBunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
const native = vi.hoisted(() => ({ post: vi.fn(), disconnect: vi.fn(), wait: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: native.wait }));
vi.mock("node:trace_events", () => ({ getEnabledCategories: () => undefined }));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => "/fixture/openclaw",
}));
vi.mock("node:inspector/promises", () => ({
  url: () => undefined,
  Session: class {
    connect() {}
    disconnect = native.disconnect;
    post = native.post;
  },
}));

function frame(functionName = "allocateRows") {
  return {
    functionName,
    scriptId: "2",
    url: "/fixture/openclaw/src/rows.js",
    lineNumber: 1,
    columnNumber: 2,
  };
}
function profile() {
  return {
    head: {
      id: 1,
      selfSize: 0,
      callFrame: { ...frame("(root)"), url: "" },
      children: [
        { id: 2, selfSize: 8192, callFrame: frame(), children: [] },
        {
          id: 3,
          selfSize: 4096,
          callFrame: { ...frame("private payload"), url: "eval://private-source" },
          children: [],
        },
      ],
    },
    samples: [
      { size: 8192, nodeId: 2, ordinal: 1 },
      { size: 4096, nodeId: 3, ordinal: 2 },
    ],
  };
}
async function capture(params = {}, signal = new AbortController().signal) {
  const { captureDiagnosticHeapProfile } = await import("./diagnostic-heap-profile.js");
  return captureDiagnosticHeapProfile({ ...params, signal, hasAuthority: () => true });
}
beforeEach(() => {
  if (hostBunVersion) {
    // Mocked native cases exercise the Node owner; the real Bun capture stays unsupported.
    Object.defineProperty(process.versions, "bun", { ...hostBunVersion, value: undefined });
  }
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("NODE_V8_COVERAGE", "");
  native.wait.mockResolvedValue(undefined);
  native.post.mockImplementation(async (method) =>
    method === "HeapProfiler.stopSampling" ? { profile: profile() } : {},
  );
});
afterEach(() => {
  if (hostBunVersion) {
    Object.defineProperty(process.versions, "bun", hostBunVersion);
  }
  vi.unstubAllEnvs();
});

describe("diagnostic heap profile owner", () => {
  it("preserves allocation samples and redacts native data before returning memory readings", async () => {
    const outcome = await capture();
    expect(outcome).toMatchObject({
      status: "complete",
      result: {
        durationMs: expect.any(Number),
        samplingIntervalBytes: 32768,
        heapUsedBefore: expect.any(Number),
        heapUsedAfter: expect.any(Number),
        rssBefore: expect.any(Number),
        rssAfter: expect.any(Number),
        truncated: false,
        redactedNodeCount: 1,
        unattributedSampleCount: 0,
        unattributedSampleBytes: 0,
        profile: { samples: profile().samples },
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/fixture|private/);
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(native.post.mock.calls.map(([method]) => method)).toEqual([
      "HeapProfiler.enable",
      "HeapProfiler.startSampling",
      "HeapProfiler.stopSampling",
      "HeapProfiler.disable",
    ]);
  });

  it("keeps attributed samples when V8 samples profile construction after translating the tree", async () => {
    const value = profile();
    value.samples.push({ nodeId: 999, size: 4096, ordinal: 3 });
    native.post.mockResolvedValue({ profile: value });
    expect(await capture()).toMatchObject({
      status: "complete",
      result: {
        truncated: true,
        unattributedSampleCount: 1,
        unattributedSampleBytes: 4096,
        profile: {
          samples: profile().samples,
          head: {
            children: expect.arrayContaining([expect.objectContaining({ id: 2, selfSize: 8192 })]),
          },
        },
      },
    });
  });

  it.each([
    { nodeId: -1, size: 4096, ordinal: 3 },
    { nodeId: 1.5, size: 4096, ordinal: 3 },
    { nodeId: 999, size: -1, ordinal: 3 },
    { nodeId: 999, size: 4096, ordinal: -1 },
  ])("rejects malformed unattributed samples %j", async (sample) => {
    const value = profile();
    value.samples.push(sample);
    native.post.mockResolvedValue({ profile: value });
    expect(await capture()).toMatchObject({ status: "unavailable", reason: "invalid-profile" });
  });

  it.each([
    [{}, 5000, 32768],
    [{ durationMs: 90000, samplingIntervalBytes: 1 }, 30000, 4096],
    [{ durationMs: 1, samplingIntervalBytes: 65536 }, 1, 65536],
  ])("applies duration and interval bounds for %j", async (params, duration, interval) => {
    await capture(params);
    expect(native.wait).toHaveBeenCalledWith(duration, undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(native.post).toHaveBeenCalledWith("HeapProfiler.startSampling", {
      samplingInterval: interval,
    });
  });

  it("rejects heap and CPU overlap, stops on cancellation, and releases ownership", async () => {
    const waiting = createDeferred();
    const controller = new AbortController();
    native.wait.mockImplementationOnce((_ms, _value, { signal }: { signal: AbortSignal }) => {
      waiting.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    const active = capture({}, controller.signal);
    await waiting.promise;
    expect(await capture()).toMatchObject({ status: "unavailable", reason: "busy" });
    const { captureDiagnosticCpuProfile } = await import("./diagnostic-cpu-profile.js");
    expect(
      await captureDiagnosticCpuProfile({ signal: controller.signal, hasAuthority: () => true }),
    ).toMatchObject({ status: "unavailable", reason: "busy" });
    controller.abort();
    expect(await active).toMatchObject({ status: "unavailable", reason: "cancelled" });
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(
      native.post.mock.calls.filter(([method]) => method === "HeapProfiler.stopSampling"),
    ).toHaveLength(1);
    expect((await capture()).status).toBe("complete");
  });

  it.each([
    "HeapProfiler.enable",
    "HeapProfiler.startSampling",
    "HeapProfiler.stopSampling",
    "HeapProfiler.disable",
  ])("cleans up after %s fails without leaking errors", async (failedMethod) => {
    native.post.mockImplementation(async (method) => {
      if (method === failedMethod) {
        throw new Error("private inspector failure");
      }
      return method === "HeapProfiler.stopSampling" ? { profile: profile() } : {};
    });
    const outcome = await capture();
    expect(outcome.status).toBe("unavailable");
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toContain("private");
  });

  it("aggregates repeated allocation stacks when the native profile exceeds 1 MiB", async () => {
    const value = profile();
    value.head.children = Array.from({ length: 9000 }, (_, index) => ({
      id: index + 2,
      selfSize: 8192,
      callFrame: frame(),
      children: [],
    }));
    value.samples = value.head.children.map((node, ordinal) => ({
      size: node.selfSize,
      nodeId: node.id,
      ordinal,
    }));
    native.post.mockResolvedValue({ profile: value });
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(1024 * 1024);
    const outcome = await capture();
    expect(outcome).toMatchObject({
      status: "complete",
      result: {
        truncated: true,
        summary: expect.arrayContaining([
          {
            stack: [
              { ...frame(), url: "openclaw:src/rows.js" },
              { ...frame("(root)"), url: "" },
            ],
            selfBytes: 9000 * 8192,
            totalBytes: 9000 * 8192,
            count: 9000,
          },
        ]),
      },
    });
    if (outcome.status !== "complete") {
      throw new Error("capture failed");
    }
    expect(Buffer.byteLength(JSON.stringify(outcome.result))).toBeLessThanOrEqual(1024 * 1024);
  });

  it("caps distinct stacks at 1 MiB, retaining the largest allocations", async () => {
    const value = profile();
    value.head.children = Array.from({ length: 9000 }, (_, index) => ({
      id: index + 2,
      selfSize: index + 1,
      callFrame: frame(`allocate${index}`),
      children: [],
    }));
    value.samples = [];
    native.post.mockResolvedValue({ profile: value });
    const outcome = await capture();
    if (outcome.status !== "complete" || !("summary" in outcome.result)) {
      throw new Error("expected summary");
    }
    expect(outcome.result.summary.length).toBeLessThan(9000);
    expect(outcome.result.summary.some((row) => row.stack[0].functionName === "allocate8999")).toBe(
      true,
    );
    expect(Buffer.byteLength(JSON.stringify(outcome.result))).toBeLessThanOrEqual(1024 * 1024);
    expect(JSON.stringify(outcome)).not.toContain("/fixture");
  });

  it.skipIf(Boolean(process.versions.bun))(
    "attributes a real in-process allocation workload within the byte cap",
    async ({ signal }) => {
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "TMPDIR", "TMP", "TEMP"]) {
        if (process.env[key]) {
          env[key] = process.env[key];
        }
      }
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const source = `
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { url } from 'node:inspector/promises';
import { captureDiagnosticHeapProfile } from ${JSON.stringify(new URL("./diagnostic-heap-profile.ts", import.meta.url).href)};
import { allocateHeapProfileWorkload } from ${JSON.stringify(new URL("./diagnostic-heap-profile.test-helpers.ts", import.meta.url).href)};
assert.equal(url(), undefined);
const pending = captureDiagnosticHeapProfile({ durationMs: 250, samplingIntervalBytes: 4096, signal: new AbortController().signal, hasAuthority: () => true });
const retained = [];
let complete = false;
void pending.finally(() => { complete = true; });
while (!complete) {
  await delay(10);
  retained.push(allocateHeapProfileWorkload());
  if (retained.length > 8) retained.shift();
}
const outcome = await pending;
assert.equal(outcome.status, 'complete', JSON.stringify(outcome));
const result = outcome.result;
assert.ok(result.profile);
assert.equal(result.truncated, result.unattributedSampleCount > 0);
const nodes = [];
const visit = node => { nodes.push(node); node.children.forEach(visit); };
visit(result.profile.head);
const allIds = new Set(nodes.map(node => node.id));
assert.ok(result.profile.samples.every(sample => allIds.has(sample.nodeId)));
const allocations = nodes.filter(node => node.callFrame.functionName === 'allocateHeapProfileWorkload' && node.selfSize > 0);
assert.ok(allocations.length > 0, 'missing workload attribution');
const selfBytes = allocations.reduce((sum, node) => sum + node.selfSize, 0);
const ids = new Set(allocations.map(node => node.id));
const count = result.profile.samples.filter(sample => ids.has(sample.nodeId)).length;
assert.ok(selfBytes > 1024 * 1024);
assert.ok(count > 0);
const resultBytes = Buffer.byteLength(JSON.stringify(result));
assert.ok(resultBytes <= 1024 * 1024);
assert.ok(!JSON.stringify(result).includes(${JSON.stringify(root)}));
assert.equal(url(), undefined);
console.log(JSON.stringify({ functionName: 'allocateHeapProfileWorkload', selfBytes, count, resultBytes, durationMs: result.durationMs, samplingIntervalBytes: result.samplingIntervalBytes, heapUsedBefore: result.heapUsedBefore, heapUsedAfter: result.heapUsedAfter, rssBefore: result.rssBefore, rssAfter: result.rssAfter, truncated: result.truncated, unattributedSampleCount: result.unattributedSampleCount, unattributedSampleBytes: result.unattributedSampleBytes, listener: false }));
assert.ok(retained.length > 0);
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
        20000,
        { cwd: root, signal, maxBuffer: 32768, requireProcessTreeExit: true },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      console.log("HEAP_PROFILE_NATIVE", result.stdout.trim());
    },
    30000,
  );
});
