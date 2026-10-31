import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsHeapProfileParams } from "../../packages/gateway-protocol/src/schema/diagnostics.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import recordedProfile from "./diagnostic-heap-profile.fixture.json" with { type: "json" };
import { diagnosticProfileEntrypoints } from "./diagnostic-profile-runtime.test-support.js";

const native = vi.hoisted(() => ({
  post: vi.fn(),
  disconnect: vi.fn(),
  wait: vi.fn(),
  resolveRoot: vi.fn(),
  heapSpaces: vi.fn(),
}));
vi.mock("node:v8", async (original) => ({
  ...(await original<typeof import("node:v8")>()),
  getHeapSpaceStatistics: native.heapSpaces,
}));
vi.mock("node:timers/promises", async (original) => ({
  ...(await original<typeof import("node:timers/promises")>()),
  setTimeout: native.wait,
}));
vi.mock("node:trace_events", () => ({ getEnabledCategories: () => undefined }));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: native.resolveRoot,
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
function profile(allocationFrame = frame(), privateUrl = "eval://private-source") {
  return {
    head: {
      id: 1,
      selfSize: 0,
      callFrame: { ...frame("(root)"), url: "" },
      children: [
        { id: 2, selfSize: 8192, callFrame: allocationFrame, children: [] },
        {
          id: 3,
          selfSize: 4096,
          callFrame: { ...frame("private payload"), url: privateUrl },
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
async function capture(
  params: DiagnosticsHeapProfileParams = {},
  signal = new AbortController().signal,
) {
  const { captureDiagnosticHeapProfile } = await import("./diagnostic-heap-profile.js");
  return captureDiagnosticHeapProfile({ ...params, signal, hasAuthority: () => true });
}
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("NODE_V8_COVERAGE", "");
  vi.stubEnv("BUN_INSPECT", "");
  vi.stubEnv("BUN_INSPECT_CONNECT_TO", "");
  native.wait.mockResolvedValue(undefined);
  native.heapSpaces.mockReturnValue([]);
  native.resolveRoot.mockResolvedValue("/fixture/openclaw");
  native.post.mockImplementation(async (method) =>
    method === "HeapProfiler.stopSampling" ? { profile: profile() } : {},
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("reports an unavailable inspector method as unsupported heap sampling", async () => {
  native.post.mockRejectedValue(
    new Error("Inspector error -32601: 'HeapProfiler.enable' wasn't found"),
  );
  expect(await capture()).toMatchObject({ status: "unavailable", reason: "unsupported" });
  const { collectRuntimeCapabilities } = await import("../infra/runtime-capabilities.js");
  expect(collectRuntimeCapabilities().capabilities.heapSampling.state).toBe("unavailable");
});

describe("diagnostic heap profile owner", () => {
  it("preserves the sanitized bytes of a recorded synthetic native profile", async () => {
    const { sanitizeDiagnosticHeapProfile } = await import("./diagnostic-heap-profile.js");
    // Recorded on Node 26; only the fixture installation path was normalized.
    // Expected bytes came from the synchronous sanitizer before this change.
    const result = await sanitizeDiagnosticHeapProfile(
      recordedProfile.raw,
      recordedProfile.packageRoot,
      { ...recordedProfile.metadata, durationLimitReason: "collected-samples" },
    );
    expect(JSON.stringify(result)).toBe(JSON.stringify(recordedProfile.sanitized));
  });

  it.each([true])(
    "preserves samples and memory readings with unattributed V8 samples=%s",
    async (unattributed) => {
      const before = [
        {
          space_name: "old_space",
          space_used_size: 100,
          space_size: 200,
          space_available_size: 50,
          physical_space_size: 180,
        },
      ];
      const after = [{ ...before[0], space_used_size: 150 }];
      native.heapSpaces.mockReturnValueOnce(before).mockReturnValueOnce(after);
      const value = profile();
      if (unattributed) {
        value.samples.push({ nodeId: 999, size: 4096, ordinal: 3 });
      }
      native.post.mockImplementation(async (method) =>
        method === "HeapProfiler.stopSampling" ? { profile: value } : {},
      );
      const outcome = await capture();
      expect(outcome).toMatchObject({
        status: "complete",
        result: {
          durationMs: expect.any(Number),
          samplingIntervalBytes: 32768,
          includeObjectsCollectedByMajorGC: false,
          includeObjectsCollectedByMinorGC: false,
          heapUsedBefore: expect.any(Number),
          heapUsedAfter: expect.any(Number),
          heapSpacesBefore: before,
          heapSpacesAfter: after,
          rssBefore: expect.any(Number),
          rssAfter: expect.any(Number),
          truncated: unattributed,
          redactedNodeCount: 1,
          unattributedSampleCount: unattributed ? 1 : 0,
          unattributedSampleBytes: unattributed ? 4096 : 0,
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
      expect(native.wait).toHaveBeenCalledWith(5000, undefined, {
        signal: expect.any(AbortSignal),
      });
      expect(native.post).toHaveBeenCalledWith("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: false,
        includeObjectsCollectedByMinorGC: false,
      });
    },
  );

  it("attributes dependency and native frames without exposing private paths or symbols", async () => {
    const dependencies: [string, string, string?][] = [
      ["/fixture/node_modules/ws/lib/buffer-util.js", "ws"],
      ["/fixture/openclaw/node_modules/undici/lib/core/util.js", "undici"],
      ["/fixture/openclaw/src/node_modules/undici/lib/core/util.js", "undici"],
      ["file:///fixture/node_modules/.pnpm/ws@8.18.0/node_modules/ws/lib/buffer-util.js", "ws"],
      ["/fixture/node_modules/@scope/pkg/lib/private.js", "@scope/pkg"],
      [
        "/fixture/node_modules/.pnpm/@scope+pkg@1.2.3/node_modules/@scope/pkg/lib/private.js",
        "@scope/pkg",
      ],
      ["/fixture/node_modules/outer/node_modules/inner/lib/private.js", "inner"],
      ["/node_modules/@openclaw/fs-safe/write.js", "@openclaw/fs-safe", "runPinnedWriteNative"],
      ["/node_modules/@openclaw/fs-safe/write.js", "@openclaw/fs-safe", "NativeStagedFile.write"],
      ["/node_modules/@openclaw/fs-safe/write.js", "@openclaw/fs-safe", "#prepare"],
      ["/node_modules/@openclaw/fs-safe/write.js", "@openclaw/fs-safe"],
    ];
    const locations: [Partial<ReturnType<typeof frame>>, string][] = [
      [{ scriptId: "0", url: "", lineNumber: -1 }, "[native]"],
      ...[
        "(V8 API)",
        "(GC)",
        "(PARSER)",
        "(COMPILER)",
        "(BYTECODE_COMPILER)",
        "(EXTERNAL)",
        "(LOGGING)",
        "(IDLE_EXTERNAL)",
        "(IDLE)",
        "(JS)",
        "(deopt)",
      ].map((functionName): [Partial<ReturnType<typeof frame>>, string] => [
        { functionName, scriptId: "0", url: "", lineNumber: -1 },
        functionName,
      ]),
      [{ scriptId: "0", url: "", lineNumber: 0 }, "[redacted]"],
      [{ scriptId: "2", url: "", lineNumber: -1 }, "[redacted]"],
      [{ scriptId: "0", url: "/private/user/secret.js", lineNumber: -1 }, "[redacted]"],
      [{ url: "/private/user/secret.js" }, "[redacted]"],
      [{ url: "/private/plugins/packages/ai/dist/secret.mjs" }, "[redacted]"],
      [{ url: "/fixture/openclaw-other/packages/ai/dist/secret.mjs" }, "[redacted]"],
      [{ url: "/fixture/openclaw/packages/ai/private/secret.js" }, "[redacted]"],
      [{ url: "/fixture/openclaw/packages/private package/dist/secret.js" }, "[redacted]"],
      [{ url: "/fixture/openclaw/packages/ai/dist/secret.mjs?private=query" }, "[redacted]"],
      [{ url: "file:///fixture/openclaw/packages/ai/dist/secret.mjs#private" }, "[redacted]"],
      [{ url: "https://private.example/node_modules/ws/secret.js" }, "[redacted]"],
      [
        { url: "/private/user/secret.js?next=/../node_modules/suffix-only/secret.js" },
        "[redacted]",
      ],
      [{ url: "/private/user/secret.js#next=/node_modules/suffix-only/secret.js" }, "[redacted]"],
      [
        { url: "/fixture/openclaw/src/node_modules/ws/secret.js?next=/../suffix-only/secret.js" },
        "[redacted]",
      ],
      [{ url: "file:///private/node_modules/ws/secret.js?private=query" }, "[redacted]"],
      [{ url: "/private/node_modules/ws/../../user/secret.js" }, "[redacted]"],
      [{ url: "/private/node_modules/.pnpm/ws@8.18.0/secret.js" }, "[redacted]"],
    ];
    const frames = [
      ...dependencies.map(([url, dependency, symbol]) => ({
        source: { ...frame(symbol ?? "private payload"), url },
        expected: { ...frame(symbol ?? `[dep:${dependency}]`), url: `node_modules/${dependency}` },
      })),
      ...locations.map(([location, functionName]) => ({
        source: { ...frame("private payload"), ...location },
        expected: { ...frame(), ...location, functionName, url: "" },
      })),
    ];
    for (const { source, expected } of frames) {
      const value = profile(source);
      native.post.mockResolvedValue({ profile: value });
      const outcome = await capture();
      expect(outcome, JSON.stringify(source)).toMatchObject({
        status: "complete",
        result: {
          redactedNodeCount: expected.functionName === "[redacted]" ? 2 : 1,
          profile: {
            samples: value.samples,
            head: {
              children: [{ id: 2, selfSize: 8192, callFrame: expected, children: [] }, { id: 3 }],
            },
          },
        },
      });
      expect(JSON.stringify(outcome)).not.toMatch(
        /fixture|private|secret|\.pnpm|8\.18\.0|1\.2\.3|buffer-util/,
      );
      if (!expected.url) {
        expect(JSON.stringify(outcome)).not.toContain("node_modules");
      }
    }
  });

  it.each([
    ["packages/ai/dist/openai-responses-shared-abc.mjs", "allocateRows", "allocateRows"],
    ["packages/gateway-protocol/dist/schema.cjs", "Schema.parse", "Schema.parse"],
    ["packages/ai/src/providers/openai.ts", "allocateRows", "allocateRows"],
    ["packages/ai/src/providers/openai.js", "private payload", "[redacted]"],
  ])("attributes workspace package %s with safe symbols", async (relative, name, expectedName) => {
    const root = "/fixture/node_modules/openclaw";
    native.resolveRoot.mockResolvedValue(root);
    native.post.mockResolvedValue({
      profile: profile({ ...frame(name), url: `file://${root}/${relative}` }),
    });
    expect(await capture()).toMatchObject({
      status: "complete",
      result: {
        redactedNodeCount: expectedName === "[redacted]" ? 2 : 1,
        profile: {
          head: {
            children: [
              { callFrame: { ...frame(expectedName), url: `openclaw:${relative}` } },
              { id: 3, callFrame: { functionName: "[redacted]", url: "" } },
            ],
          },
        },
      },
    });
  });

  it.each([
    "/fixture/node_modules/openclaw",
    "/fixture/node_modules/.pnpm/openclaw@1.0.0/node_modules/openclaw",
  ])("preserves OpenClaw code attribution when installed at %s", async (root) => {
    native.resolveRoot.mockResolvedValue(root);
    const value = profile({ ...frame(), url: `${root}/dist/rows.js` }, `${root}/private/secret.js`);
    native.post.mockResolvedValue({ profile: value });
    expect(await capture()).toMatchObject({
      status: "complete",
      result: {
        profile: {
          head: {
            children: [
              { callFrame: { ...frame(), url: "openclaw:dist/rows.js" } },
              { id: 3, callFrame: { functionName: "[redacted]", url: "" } },
            ],
          },
        },
      },
    });
  });

  it.each<
    [DiagnosticsHeapProfileParams, number, number, "collected-samples" | "maximum-duration" | null]
  >([
    [{ durationMs: 900_000, samplingIntervalBytes: 1 }, 900_000, 4096, null],
    [
      {
        durationMs: 1_000_000,
        includeObjectsCollectedByMajorGC: false,
        includeObjectsCollectedByMinorGC: false,
      },
      900_000,
      32768,
      "maximum-duration",
    ],
    [
      { durationMs: 900_000, includeObjectsCollectedByMajorGC: true },
      30_000,
      32768,
      "collected-samples",
    ],
    [
      { durationMs: 900_000, includeObjectsCollectedByMinorGC: true },
      30_000,
      32768,
      "collected-samples",
    ],
    [{ durationMs: 1, samplingIntervalBytes: 65536 }, 1, 65536, null],
  ])(
    "applies sampling options and bounds for %j",
    async (params, duration, interval, limitReason) => {
      const collectionOptions = {
        includeObjectsCollectedByMajorGC: params.includeObjectsCollectedByMajorGC ?? false,
        includeObjectsCollectedByMinorGC: params.includeObjectsCollectedByMinorGC ?? false,
      };
      const outcome = await capture(params);
      expect(outcome).toMatchObject({
        status: "complete",
        result: {
          ...collectionOptions,
          requestedDurationMs: params.durationMs,
          effectiveDurationMs: duration,
          actualDurationMs: expect.any(Number),
          durationLimitReason: limitReason,
        },
      });
      if (outcome.status === "complete") {
        expect(outcome.result.actualDurationMs).toBe(outcome.result.durationMs);
      }
      expect(native.wait).toHaveBeenCalledWith(duration, undefined, {
        signal: expect.any(AbortSignal),
      });
      expect(native.post).toHaveBeenCalledWith("HeapProfiler.startSampling", {
        samplingInterval: interval,
        ...collectionOptions,
      });
    },
  );

  it.each([
    [{ includeCollected: true }, true, true, 30_000],
    [{ includeCollected: false }, false, false, 900_000],
    [{ includeCollected: true, includeObjectsCollectedByMinorGC: false }, true, false, 30_000],
  ] as const)(
    "supports collected-allocation shorthand %j",
    async (params, major, minor, duration) => {
      expect(await capture({ ...params, durationMs: 900_000 })).toMatchObject({
        status: "complete",
        result: {
          includeObjectsCollectedByMajorGC: major,
          includeObjectsCollectedByMinorGC: minor,
        },
      });
      expect(native.wait).toHaveBeenCalledWith(duration, undefined, {
        signal: expect.any(AbortSignal),
      });
    },
  );

  it("rejects overlap, cancels a long retention window, and releases ownership", async () => {
    const waiting = createDeferred();
    const controller = new AbortController();
    native.wait.mockImplementationOnce((_ms, _value, { signal }: { signal: AbortSignal }) => {
      waiting.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    const active = capture({ durationMs: 900_000 }, controller.signal);
    await waiting.promise;
    expect(native.wait).toHaveBeenCalledWith(900_000, undefined, { signal: controller.signal });
    expect(await capture()).toMatchObject({ status: "unavailable", reason: "busy" });
    const { captureDiagnosticCpuProfile } = await import("./diagnostic-cpu-profile.js");
    expect(
      await captureDiagnosticCpuProfile({ signal: controller.signal, hasAuthority: () => true }),
    ).toMatchObject({ status: "unavailable", reason: "busy" });
    controller.abort();
    expect(await active).toEqual({
      status: "unavailable",
      reason: "cancelled",
      cleanupFailed: false,
    });
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(
      native.post.mock.calls.filter(([method]) => method === "HeapProfiler.stopSampling"),
    ).toHaveLength(1);
    expect(native.post).toHaveBeenCalledWith("HeapProfiler.disable");
    expect((await capture()).status).toBe("complete");
  });

  it("aggregates repeated allocation stacks when the native profile exceeds 1 MiB", async () => {
    const value = profile();
    value.head.children = Array.from({ length: 9000 }, (_, index) => ({
      id: index + 2,
      selfSize: 8192,
      callFrame: { ...frame("private payload"), url: "/fixture/node_modules/ws/lib/private.js" },
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
        redactedNodeCount: 0,
        summary: expect.arrayContaining([
          {
            stack: [
              { ...frame("[dep:ws]"), url: "node_modules/ws" },
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

  it("yields during sanitization while retaining capture ownership and checking revocation", async () => {
    const value = profile();
    value.head.children = Array.from({ length: 9000 }, (_, index) => ({
      id: index + 2,
      selfSize: 8192,
      callFrame: frame(),
      children: [],
    }));
    const stopped = createDeferred();
    native.post.mockImplementation(async (method) => {
      if (method === "HeapProfiler.stopSampling") {
        stopped.resolve();
        return { profile: value };
      }
      return {};
    });
    let authorized = true;
    let completed = false;
    const { captureDiagnosticHeapProfile } = await import("./diagnostic-heap-profile.js");
    const active = captureDiagnosticHeapProfile({
      signal: new AbortController().signal,
      hasAuthority: () => authorized,
    }).then((outcome) => {
      completed = true;
      return outcome;
    });
    await stopped.promise;
    await nextTurn();
    expect(completed).toBe(false);
    expect(await capture()).toMatchObject({ status: "unavailable", reason: "busy" });
    authorized = false;
    expect(await active).toMatchObject({ status: "unavailable", reason: "cancelled" });
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect((await capture()).status).toBe("complete");
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

  it("attributes retained allocations and opt-in collected allocations within the byte cap", async ({
    signal,
  }) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "OPENCLAW_STATE_DIR", "TMPDIR", "TMP", "TEMP"]) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const ownerUrl = resolveRuntimeWorkerUrl(diagnosticProfileEntrypoints.heap);
    const workloadUrl = new URL("./diagnostic-heap-profile.test-helpers.ts", import.meta.url).href;
    const preparedWorkloadUrl = resolveRuntimeWorkerUrl(diagnosticProfileEntrypoints.workload);
    const source = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';
import { Session, url } from 'node:inspector/promises';
import { captureDiagnosticHeapProfile } from ${JSON.stringify(ownerUrl.href)};
// Preserve the workload's real source location for the owner's attribution policy.
if (${JSON.stringify(preparedWorkloadUrl.href)} !== ${JSON.stringify(workloadUrl)}) {
  registerHooks({ load(url, context, nextLoad) {
    if (url === ${JSON.stringify(workloadUrl)}) {
      return { format: 'module', source: readFileSync(new URL(${JSON.stringify(preparedWorkloadUrl.href)}), 'utf8'), shortCircuit: true };
    }
    return nextLoad(url, context);
  }});
}
const { allocateHeapProfileWorkload, allocateDroppedHeapProfileWorkload } = await import(${JSON.stringify(workloadUrl)});
assert.equal(url(), undefined);
assert.equal(process.versions.bun ?? null, ${JSON.stringify(process.versions.bun ?? null)});
// Run each workload at the capture window boundary, without timer sleeps or polling.
let retained;
timers.setTimeout = async () => { retained = allocateHeapProfileWorkload(); };
syncBuiltinESMExports();
const options = { durationMs: 1, samplingIntervalBytes: 65536, signal: new AbortController().signal, hasAuthority: () => true };
const outcome = await captureDiagnosticHeapProfile(options);
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
console.log(JSON.stringify({ node: process.version, bun: process.versions.bun ?? null, functionName: 'allocateHeapProfileWorkload', selfBytes, count, resultBytes, durationMs: result.durationMs, samplingIntervalBytes: result.samplingIntervalBytes, heapUsedBefore: result.heapUsedBefore, heapUsedAfter: result.heapUsedAfter, rssBefore: result.rssBefore, rssAfter: result.rssAfter, truncated: result.truncated, unattributedSampleCount: result.unattributedSampleCount, unattributedSampleBytes: result.unattributedSampleBytes, listener: false }));
assert.ok(retained.length > 0);
retained = undefined;
// Initialize V8's retained feedback and allocation sites outside the sampled window.
for (let pass = 0; pass < 2; pass++) {
  allocateDroppedHeapProfileWorkload(10);
}
timers.setTimeout = async () => {
  allocateDroppedHeapProfileWorkload();
  await globalThis.gc({ type: "major", execution: "async" });
};
syncBuiltinESMExports();
for (const includeCollected of [false, true]) {
  await globalThis.gc({ type: "major", execution: "async" });
  const outcome = await captureDiagnosticHeapProfile({
    ...options,
    includeObjectsCollectedByMajorGC: includeCollected,
    includeObjectsCollectedByMinorGC: includeCollected,
  });
  assert.equal(outcome.status, 'complete', JSON.stringify(outcome));
  const result = outcome.result;
  assert.ok(result.profile);
  const nodes = [result.profile.head];
  let selfBytes = 0;
  for (const node of nodes) {
    if (node.callFrame.functionName === 'allocateDroppedHeapProfileWorkload') selfBytes += node.selfSize;
    nodes.push(...node.children);
  }
  console.log(JSON.stringify({ includeCollected, allocatedBytes: 200 * 1024 * 1024, selfBytes, durationMs: result.durationMs }));
  assert.ok(includeCollected ? selfBytes > 190 * 1024 * 1024 : selfBytes === 0, 'collected allocation attribution');
  if (includeCollected) {
    assert.equal(result.includeObjectsCollectedByMajorGC, true);
    assert.equal(result.includeObjectsCollectedByMinorGC, true);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
  assert.ok(!JSON.stringify(result).includes(${JSON.stringify(root)}));
}
assert.equal(url(), undefined);
const inspector = new Session();
inspector.connect();
try {
  await assert.rejects(inspector.post('HeapProfiler.getSamplingProfile'), /sampling heap profiler was not started/);
} finally {
  inspector.disconnect();
}
`;
    const result = await runNodeScript(
      (workerArgv) => [
        ...workerArgv(ownerUrl).slice(0, -1),
        "--expose-gc",
        "--input-type=module",
        "--eval",
        source,
      ],
      env,
      20000,
      {
        cwd: root,
        signal,
        maxBuffer: 32768,
        requireProcessTreeExit: true,
        executable: process.execPath,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, [result.stderr, result.stdout].join("\n")).toBe(0);
    console.log("HEAP_PROFILE_NATIVE", result.stdout.trim());
  }, 30000);
});
