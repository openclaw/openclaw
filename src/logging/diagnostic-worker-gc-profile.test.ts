import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { captureWorkerGcProfiles, writeWorkerGcProfiles } from "./diagnostic-worker-gc-profile.js";

const native = vi.hoisted(() => ({ post: vi.fn(), disconnect: vi.fn(), wait: vi.fn() }));
// mock-isolation: Native inspector results are the input boundary; retain the real capture owner,
// sanitizers, serialized writer, filesystem, and retention policy.
vi.mock("node:inspector/promises", () => ({
  url: () => undefined,
  Session: class {
    connect() {}
    post = native.post;
    disconnect = native.disconnect;
  },
}));
vi.mock("node:timers/promises", () => ({ setTimeout: native.wait }));
vi.mock("node:trace_events", () => {
  throw new Error("trace_events must not load in a worker");
});
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => "/fixture/openclaw",
}));

const privateFrame = {
  functionName: "secret guest payload",
  url: "openclaw-code-mode:user.js?secret",
  scriptId: "12",
  lineNumber: 0,
  columnNumber: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("NODE_V8_COVERAGE", "");
  native.wait.mockResolvedValue(undefined);
  native.post.mockImplementation(async (method: string) => {
    if (method === "HeapProfiler.stopSampling") {
      return {
        profile: {
          head: { id: 1, callFrame: privateFrame, selfSize: 8192, children: [] },
          samples: [{ size: 8192, nodeId: 1, ordinal: 1 }],
        },
      };
    }
    if (method === "Profiler.stop") {
      return {
        profile: {
          nodes: [{ id: 1, callFrame: privateFrame, hitCount: 1 }],
          samples: [1],
          timeDeltas: [10000],
          startTime: 0,
          endTime: 5_000_000,
        },
      };
    }
    return {};
  });
});
afterEach(() => vi.unstubAllEnvs());

it("captures collected allocations and CPU together, redacts guest frames, and closes both profilers", async () => {
  const outcome = await captureWorkerGcProfiles();
  expect(outcome.status).toBe("complete");
  if (outcome.status !== "complete") {
    throw new Error(JSON.stringify(outcome));
  }
  expect(native.post).toHaveBeenCalledWith("HeapProfiler.startSampling", {
    samplingInterval: 262144,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  expect(native.wait).toHaveBeenCalledWith(5000, undefined, { signal: expect.any(AbortSignal) });
  expect(JSON.parse(outcome.result.heap)).toMatchObject({
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
    profile: { samples: [{ size: 8192, nodeId: 1, ordinal: 1 }] },
  });
  expect(JSON.parse(outcome.result.cpu)).toMatchObject({ profile: { samples: [1] } });
  expect(JSON.stringify(outcome.result)).not.toMatch(/secret|user\.js/);
  expect(native.post).toHaveBeenCalledWith("HeapProfiler.disable");
  expect(native.post).toHaveBeenCalledWith("Profiler.disable");
  expect(native.disconnect).toHaveBeenCalledTimes(1);
});

it("cleans up both domains when CPU startup fails after heap sampling starts", async () => {
  const post = native.post.getMockImplementation()!;
  native.post.mockImplementation((method: string, params: unknown) => {
    if (method === "Profiler.start") {
      throw new Error("synthetic inspector failure");
    }
    return post(method, params);
  });
  expect(await captureWorkerGcProfiles()).toMatchObject({
    status: "unavailable",
    reason: "capture-failed",
  });
  expect(native.post).toHaveBeenCalledWith("HeapProfiler.stopSampling");
  expect(native.post).toHaveBeenCalledWith("HeapProfiler.disable");
  expect(native.post).toHaveBeenCalledWith("Profiler.disable");
  expect(native.disconnect).toHaveBeenCalledTimes(1);
});

it("bounds concurrent worker artifacts globally and preserves unrelated diagnostics", async () => {
  await withTempDir("worker-gc-profile-", async (stateDir) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const directory = path.join(stateDir, "diagnostics");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "heap-existing.heapsnapshot"), "keep");
    await fs.writeFile(path.join(directory, "code-mode-gc-user-notes.json"), "keep");
    const outcome = await captureWorkerGcProfiles();
    if (outcome.status !== "complete") {
      throw new Error(JSON.stringify(outcome));
    }
    const batches = await Promise.all(
      Array.from({ length: 12 }, () => writeWorkerGcProfiles(outcome.result)),
    );
    const files = await fs.readdir(directory);
    expect(files).toHaveLength(22);
    expect(files).toContain("heap-existing.heapsnapshot");
    expect(files).toContain("code-mode-gc-user-notes.json");
    expect(files).not.toContain(batches[0]![0]);
    for (const filename of batches.at(-1)!) {
      const file = path.join(directory, filename);
      const content = await fs.readFile(file, "utf8");
      expect(content).not.toMatch(/secret|user\.js/);
      expect(JSON.parse(content)).toHaveProperty("profile");
      if (process.platform !== "win32") {
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      }
    }
  });
});
