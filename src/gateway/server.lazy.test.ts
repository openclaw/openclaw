/**
 * Lazy gateway server entrypoint tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalTrace = process.env.OPENCLAW_GATEWAY_STARTUP_TRACE;

describe("gateway server boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OPENCLAW_GATEWAY_STARTUP_TRACE = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("./server-start.js");
    vi.doUnmock("../process/spawn-broker/context.js");
    vi.resetModules();
    if (originalTrace === undefined) {
      delete process.env.OPENCLAW_GATEWAY_STARTUP_TRACE;
    } else {
      process.env.OPENCLAW_GATEWAY_STARTUP_TRACE = originalTrace;
    }
  });

  it("lazy-loads server-start on demand", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stopped = new Error("test stopped after startup module activation");
    vi.doMock("./server-start.js", () => ({
      startGatewayServerCore: async () => {
        throw stopped;
      },
    }));
    vi.doMock("../process/spawn-broker/context.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../process/spawn-broker/context.js")>()),
      startGatewaySpawnBroker: async () => undefined,
    }));

    const mod = await import("./server.js");
    expect(stderrWrite).not.toHaveBeenCalledWith(
      expect.stringContaining("gateway.server-start-import"),
    );

    await expect(mod.startGatewayServer(0)).rejects.toBe(stopped);

    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("gateway.server-start-import"),
    );
  });
});
