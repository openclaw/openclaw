import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { captureWorkerGcProfiles, writeWorkerGcProfiles } from "./diagnostic-worker-gc-profile.js";

const native = vi.hoisted(() => ({ post: vi.fn(), disconnect: vi.fn(), wait: vi.fn() }));
// mock-isolation: Only native inspector/timer inputs are mocked; capture, redaction and storage are real.
vi.mock("node:inspector/promises", () => ({
  url: () => undefined,
  Session: class {
    connect() {}
    post = native.post;
    disconnect = native.disconnect;
  },
}));
vi.mock("node:timers/promises", () => ({ setTimeout: native.wait }));
vi.mock("node:trace_events", () => assert.fail("trace_events must not load in a worker"));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => "/fixture/openclaw",
}));

const callFrame = {
  functionName: "secret guest payload",
  url: "openclaw-code-mode:user.js?secret",
  scriptId: "12",
  lineNumber: 0,
  columnNumber: 0,
};
const samples = [{ size: 8192, nodeId: 1, ordinal: 1 }];
const heap = { head: { id: 1, callFrame, selfSize: 8192, children: [] }, samples };
const cpu = {
  nodes: [{ id: 1, callFrame, hitCount: 1 }],
  samples: [1],
  timeDeltas: [10000],
  startTime: 0,
  endTime: 5_000_000,
};
let failCpuStart = false;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("NODE_V8_COVERAGE", "");
  failCpuStart = false;
  native.wait.mockResolvedValue(undefined);
  native.post.mockImplementation(async (method: string) => {
    if (failCpuStart && method === "Profiler.start") {
      throw new Error("synthetic inspector failure");
    }
    if (method === "HeapProfiler.stopSampling") {
      return { profile: heap };
    }
    if (method === "Profiler.stop") {
      return { profile: cpu };
    }
    return {};
  });
});
afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("closes profilers (CPU start failure=%s)", async (fails) => {
  failCpuStart = fails;
  const outcome = await captureWorkerGcProfiles();
  if (fails) {
    expect(outcome).toMatchObject({ status: "unavailable", reason: "capture-failed" });
    expect(native.post).toHaveBeenCalledWith("HeapProfiler.stopSampling");
  } else {
    assert(outcome.status === "complete", JSON.stringify(outcome));
    expect(native.post).toHaveBeenCalledWith("HeapProfiler.startSampling", {
      samplingInterval: 262144,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    expect(native.wait.mock.calls.map(([duration]) => duration)).toEqual([5000]);
    expect(JSON.parse(outcome.result.heap)).toMatchObject({
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
      profile: { samples: [{ size: 8192, nodeId: 1, ordinal: 1 }] },
    });
    expect(JSON.parse(outcome.result.cpu)).toMatchObject({ profile: { samples: [1] } });
    expect(JSON.stringify(outcome.result)).not.toMatch(/secret|user\.js/);
  }
  for (const domain of ["HeapProfiler", "Profiler"]) {
    expect(native.post).toHaveBeenCalledWith(`${domain}.disable`);
  }
  expect(native.disconnect).toHaveBeenCalledTimes(1);
});

it("bounds concurrent worker artifacts globally and preserves unrelated diagnostics", async () => {
  await withTempDir("worker-gc-profile-", async (stateDir) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const directory = path.join(stateDir, "diagnostics");
    await fs.mkdir(directory);
    const preserved = ["heap-existing.heapsnapshot", "code-mode-gc-user-notes.json"];
    await Promise.all(preserved.map((name) => fs.writeFile(path.join(directory, name), "keep")));
    const outcome = await captureWorkerGcProfiles();
    assert(outcome.status === "complete", JSON.stringify(outcome));
    const batches = await Promise.all(
      Array.from({ length: 12 }, () => writeWorkerGcProfiles(outcome.result)),
    );
    const files = await fs.readdir(directory);
    expect(files).toHaveLength(22);
    expect(files).toEqual(expect.arrayContaining(preserved));
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
