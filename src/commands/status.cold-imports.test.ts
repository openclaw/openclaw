// Default status imports must not pull in the broad plugin diagnostics/runtime graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import "../test-utils/prepare-compiled-subprocesses.js";

describe("status cold imports", () => {
  afterEach(() => {
    vi.doUnmock("../plugins/status.js");
    vi.doUnmock("../agents/model-auth-label.js");
    vi.doUnmock("../daemon/service.js");
    vi.doUnmock("../daemon/node-service.js");
    vi.doUnmock("../infra/openclaw-root.js");
    vi.resetModules();
  });

  it("isolates failed usage imports from default runtime status", async () => {
    const usageImportFailure = new Error("usage credential resolution failed to load");
    vi.doMock("../agents/model-auth-label.js", () => {
      throw usageImportFailure;
    });
    vi.doMock("../daemon/service.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../daemon/service.js")>()),
      resolveGatewayService: () => createMockGatewayService({ label: "gateway" }),
    }));
    vi.doMock("../daemon/node-service.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../daemon/node-service.js")>()),
      resolveNodeService: () => createMockGatewayService({ label: "node" }),
    }));
    vi.doMock("../infra/openclaw-root.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
      resolveOpenClawPackageRoot: async () => null,
    }));

    const { resolveStatusRuntimeSnapshot } = await import("./status-runtime-shared.js");
    const params = {
      config: {},
      sourceConfig: {},
      gatewayReachable: false,
      gatewayProbeDeadlineMs: performance.now() + 60_000,
    };
    const snapshot = await resolveStatusRuntimeSnapshot(params);

    expect(snapshot).toEqual({
      securityAudit: undefined,
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
      gatewayService: expect.objectContaining({ label: "gateway" }),
      nodeService: expect.objectContaining({ label: "node" }),
    });

    // Usage collection must preserve its failure without breaking pure text formatting.
    await expect(resolveStatusRuntimeSnapshot({ ...params, usage: true })).rejects.toMatchObject({
      cause: usageImportFailure,
    });
    const { formatUsageReportLines } = await import("./status.command.text-runtime.js");
    expect(formatUsageReportLines({ updatedAt: 0, providers: [] })).toEqual([
      "Usage: no provider usage available.",
    ]);
    await expect(resolveStatusRuntimeSnapshot(params)).resolves.toEqual(snapshot);
  });

  it("keeps broad plugin status code out of default status imports", async () => {
    vi.doMock("../plugins/status.js", () => {
      throw new Error("default status must not import broad plugin diagnostics");
    });

    const [scan, textRuntime] = await Promise.all([
      import("./status.scan.js"),
      import("./status.command.text-runtime.js"),
    ]);

    expect(scan.scanStatus).toBeTypeOf("function");
    expect(textRuntime.buildStatusCommandReportLines).toBeTypeOf("function");
  });
});
