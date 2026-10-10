import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { diagnosticProfileEntrypoints } from "../../logging/diagnostic-profile-runtime.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayRequestOptions } from "./types.js";

const native = vi.hoisted(() => ({ write: vi.fn(), warn: vi.fn() }));
vi.mock("node:v8", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:v8")>()),
  writeHeapSnapshot: native.write,
  getHeapSpaceStatistics: () => [],
}));
// Mocked captures must not clear the test worker's own profiler state.
vi.mock("node:inspector/promises", () => ({
  url: () => undefined,
  Session: class {
    connect() {}
    disconnect() {}
    async post() {}
  },
}));
vi.mock("node:trace_events", () => ({ getEnabledCategories: () => undefined }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (...args: Parameters<typeof original.createSubsystemLogger>) => {
      const logger = original.createSubsystemLogger(...args);
      return {
        ...logger,
        child: (...childArgs: Parameters<typeof logger.child>) => ({
          ...logger.child(...childArgs),
          warn: native.warn,
        }),
      };
    },
  };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let clock = 0;
const memory = process.memoryUsage();

function request(
  options: {
    role?: string;
    scopes?: string[];
    params?: unknown;
    hasAuthority?: () => boolean;
  } = {},
) {
  const respond = vi.fn();
  const pending = handleGatewayRequest({
    req: {
      type: "req",
      id: "heap-snapshot",
      method: "diagnostics.heapSnapshot",
      params: options.params,
    },
    respond,
    client: {
      connId: "snapshot-client",
      connect: {
        role: options.role ?? "operator",
        scopes: options.scopes ?? ["operator.admin"],
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
      },
    } as GatewayRequestOptions["client"],
    isWebchatConnect: () => false,
    context: { logGateway: { warn: vi.fn() } } as unknown as GatewayRequestOptions["context"],
    hasCurrentClientAuthority: options.hasAuthority,
  });
  return { respond, pending };
}

function runSnapshotScript(source: string, ownerUrl: URL, signal: AbortSignal, executable: string) {
  const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: stateDir };
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  return runNodeScript(
    (workerArgv) => [...workerArgv(ownerUrl).slice(0, -1), "--input-type=module", "--eval", source],
    env,
    20_000,
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      signal,
      maxBuffer: 32768,
      requireProcessTreeExit: true,
      executable,
    },
  );
}

beforeEach(() => {
  stateDir = tempDirs.make("openclaw-heap-snapshot-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("NODE_V8_COVERAGE", "");
  vi.stubEnv("BUN_INSPECT", "");
  vi.stubEnv("BUN_INSPECT_CONNECT_TO", "");
  setActivePluginRegistry(createEmptyPluginRegistry());
  clock += 120_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(process, "memoryUsage").mockReturnValue({ ...memory, heapUsed: 1024 });
  native.warn.mockReset();
  native.write.mockReset().mockImplementation((filename: string) => {
    expect(native.warn).toHaveBeenCalled();
    writeFileSync(filename, "fixture snapshot");
    clock += 25;
    return filename;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("diagnostics.heapSnapshot", () => {
  it.each([
    { role: "operator", scopes: ["operator.write"] },
    { role: "node", scopes: ["operator.admin"] },
  ])("rejects $role/$scopes before native work", async (options) => {
    const call = request(options);
    await call.pending;
    expect(native.write).not.toHaveBeenCalled();
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: options.role === "node" ? "INVALID_REQUEST" : "FORBIDDEN" }),
    );
  });

  it("rejects path-controlling params", async () => {
    const call = request({ params: { path: "/tmp/override" } });
    await call.pending;
    expect(native.write).not.toHaveBeenCalled();
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("returns only file metadata, writes privately, and refuses immediate recapture", async () => {
    const stat = fs.stat.bind(fs);
    // Model queued allocations running after native capture while metadata is awaited.
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (String(args[0]).endsWith(".heapsnapshot")) {
        vi.mocked(process.memoryUsage).mockReturnValue({ ...memory, heapUsed: 8192 });
      }
      return result;
    });
    const call = request({ params: { reason: "retention baseline" } });
    await call.pending;
    const result = call.respond.mock.calls[0]?.[1];
    expect(call.respond).toHaveBeenCalledWith(
      true,
      {
        path: expect.stringMatching(/heap-.*\.heapsnapshot$/),
        sizeBytes: 16,
        heapUsedBefore: 1024,
        heapUsedAfter: 1024,
        elapsedMs: 25,
      },
      undefined,
    );
    expect(path.dirname(result.path)).toBe(path.join(stateDir, "diagnostics"));
    expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
    const repeated = request();
    await repeated.pending;
    expect(repeated.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: { reason: "cooldown", cleanupFailed: false },
      }),
    );
    expect(native.write).toHaveBeenCalledTimes(1);
  });

  it.each(["authority", "heap"])(
    "rechecks %s after awaited preparation and rejects overlap",
    async (guard) => {
      const entered = createDeferred();
      const release = createDeferred();
      const mkdir = fs.mkdir.bind(fs);
      vi.spyOn(fs, "mkdir").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return mkdir(...args);
      });
      let authorized = true;
      const first = request({ hasAuthority: () => authorized });
      await entered.promise;
      const second = request();
      await second.pending;
      expect(second.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ details: { reason: "busy", cleanupFailed: false } }),
      );
      const { captureDiagnosticHeapProfile } =
        await import("../../logging/diagnostic-heap-profile.js");
      expect(
        await captureDiagnosticHeapProfile({
          durationMs: 1,
          signal: new AbortController().signal,
          hasAuthority: () => true,
        }),
      ).toMatchObject({ status: "unavailable", reason: "busy" });
      if (guard === "authority") {
        authorized = false;
      } else {
        vi.mocked(process.memoryUsage).mockReturnValue({ ...memory, heapUsed: 6 * 1024 ** 3 + 1 });
      }
      release.resolve();
      await first.pending;
      expect(native.write).not.toHaveBeenCalled();
      expect(await fs.readdir(path.join(stateDir, "diagnostics"))).toEqual([]);
      if (guard === "authority") {
        expect(first.respond).not.toHaveBeenCalled();
      } else {
        expect(first.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { reason: "heap-too-large", cleanupFailed: false } }),
        );
      }
    },
  );

  it("removes partial captures and releases the lock after native failure", async () => {
    native.write.mockImplementationOnce((filename: string) => {
      writeFileSync(filename, "partial");
      throw new Error("disk full");
    });
    const failed = request();
    await failed.pending;
    expect(failed.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: { reason: "capture-failed", cleanupFailed: false },
      }),
    );
    expect(await fs.readdir(path.join(stateDir, "diagnostics"))).toEqual([]);
    clock += 60_001;
    const recovered = request();
    await recovered.pending;
    expect(recovered.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sizeBytes: 16 }),
      undefined,
    );
  });

  it("captures a native snapshot with the current runtime without opening a listener", async ({
    signal,
  }) => {
    vi.restoreAllMocks();
    const ownerUrl = resolveRuntimeWorkerUrl(diagnosticProfileEntrypoints.snapshot);
    const source = `
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { url } from 'node:inspector/promises';
import path from 'node:path';
import { captureDiagnosticHeapSnapshot } from ${JSON.stringify(ownerUrl.href)};
assert.equal(process.versions.bun ?? null, ${JSON.stringify(process.versions.bun ?? null)});
assert.equal(url(), undefined);
globalThis.snapshotMarker = { label: 'synthetic retention marker' };
const outcome = await captureDiagnosticHeapSnapshot({ signal: new AbortController().signal, hasAuthority: () => true });
assert.equal(outcome.status, 'complete', JSON.stringify(outcome));
const result = outcome.result;
const metadata = await stat(result.path);
assert.ok(result.sizeBytes > 0);
assert.equal(result.sizeBytes, metadata.size);
// Windows stat mode bits do not encode owner-only ACL permissions.
if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o600);
assert.equal(path.dirname(result.path), path.join(process.env.OPENCLAW_STATE_DIR, 'diagnostics'));
for (const value of [result.heapUsedBefore, result.heapUsedAfter, result.elapsedMs]) {
  assert.ok(Number.isFinite(value) && value >= 0);
}
const snapshot = JSON.parse(await readFile(result.path, 'utf8'));
assert.ok(snapshot.snapshot.node_count > 0);
assert.ok(snapshot.strings.includes(globalThis.snapshotMarker.label));
assert.equal(url(), undefined);
console.log(JSON.stringify({ node: process.version, bun: process.versions.bun ?? null, sizeBytes: result.sizeBytes, listener: false }));
`;
    const result = await runSnapshotScript(source, ownerUrl, signal, process.execPath);
    expect(result.error).toBeUndefined();
    expect(result.status, [result.stderr, result.stdout].join("\n")).toBe(0);
    console.log("HEAP_SNAPSHOT_NATIVE", result.stdout.trim());
  }, 30_000);

  it("releases V8 object IDs after writing a native snapshot under Node", async ({ signal }) => {
    vi.restoreAllMocks();
    const ownerUrl = resolveRuntimeWorkerUrl(diagnosticProfileEntrypoints.snapshot);
    const source = `
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { captureDiagnosticHeapSnapshot } from ${JSON.stringify(ownerUrl.href)};
assert.equal(process.versions.bun, undefined, 'V8 tracking regression requires real Node');
globalThis.snapshotMarker = { label: 'synthetic retention marker' };
const observer = new Session();
observer.connect();
try {
  const { result } = await observer.post('Runtime.evaluate', { expression: 'globalThis.snapshotMarker' });
  const outcome = await captureDiagnosticHeapSnapshot({ signal: new AbortController().signal, hasAuthority: () => true });
  assert.equal(outcome.status, 'complete', JSON.stringify(outcome));
  assert.ok(outcome.result.sizeBytes > 0);
  assert.equal((await stat(outcome.result.path)).mode & 0o777, 0o600);
  const snapshot = JSON.parse(await readFile(outcome.result.path, 'utf8'));
  assert.ok(snapshot.snapshot.node_count > 0);
  assert.ok(snapshot.strings.includes('synthetic retention marker'));
  // Keep the observer connected: disconnecting it would hide leaked V8 tracking.
  const { heapSnapshotObjectId } = await observer.post('HeapProfiler.getHeapObjectId', { objectId: result.objectId });
  assert.equal(heapSnapshotObjectId, '0', 'snapshot left V8 object-move tracking active');
} finally {
  observer.disconnect();
}
`;
    const result = await runSnapshotScript(source, ownerUrl, signal, resolveTestNodeExecPath());
    expect(result.error).toBeUndefined();
    expect(result.status, [result.stderr, result.stdout].join("\n")).toBe(0);
  }, 30_000);
});
