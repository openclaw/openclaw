import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayRequestOptions } from "./types.js";

const native = vi.hoisted(() => ({ write: vi.fn(), warn: vi.fn() }));
vi.mock("node:v8", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:v8")>()),
  writeHeapSnapshot: native.write,
}));
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
    scopes?: string[];
    role?: string;
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

beforeEach(() => {
  vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: undefined } });
  stateDir = tempDirs.make("openclaw-heap-snapshot-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
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
  vi.unstubAllGlobals();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("diagnostics.heapSnapshot", () => {
  it("refuses Bun snapshots before filesystem preparation or native capture", async () => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "1.4.2" } });
    const call = request();
    await call.pending;
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: { reason: "unsupported", cleanupFailed: false },
      }),
    );
    expect(native.write).not.toHaveBeenCalled();
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it.each([
    { scopes: [] },
    { scopes: ["operator.read"] },
    { scopes: ["operator.write"] },
    { role: "node", scopes: ["operator.admin"] },
  ])("rejects non-admin operators and node clients: %j", async (options) => {
    const call = request(options);
    await call.pending;
    expect(native.write).not.toHaveBeenCalled();
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: options.role === "node" ? "INVALID_REQUEST" : "FORBIDDEN" }),
    );
  });

  it.each([null, [], { reason: 1 }, { reason: "x".repeat(257) }, { path: "/tmp/override" }])(
    "rejects malformed or path-controlling params %j",
    async (params) => {
      const call = request({ params });
      await call.pending;
      expect(native.write).not.toHaveBeenCalled();
      expect(call.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    },
  );

  it("returns only file metadata, writes privately, and refuses immediate recapture", async () => {
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

  it("refuses heaps over 6 GiB before filesystem preparation", async () => {
    vi.mocked(process.memoryUsage).mockReturnValue({ ...memory, heapUsed: 6 * 1024 ** 3 + 1 });
    const call = request();
    await call.pending;
    expect(call.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: { reason: "heap-too-large", cleanupFailed: false },
      }),
    );
    expect(native.write).not.toHaveBeenCalled();
    expect(await fs.readdir(stateDir)).toEqual([]);
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
});
