import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

const nodeUtilsMocks = vi.hoisted(() => ({
  resolveNodeId: vi.fn(async () => "node-1"),
  resolveNode: vi.fn(async () => ({ nodeId: "node-1", remoteIp: "127.0.0.1" })),
}));

const nodesCameraMocks = vi.hoisted(() => ({
  cameraTempPath: vi.fn(({ facing }: { facing?: string }) =>
    facing ? `/tmp/camera-${facing}.jpg` : "/tmp/camera.jpg",
  ),
  parseCameraClipPayload: vi.fn(),
  parseCameraSnapPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "jpg",
    width: 800,
    height: 600,
  })),
  writeCameraClipPayloadToFile: vi.fn(),
  writeCameraPayloadToFile: vi.fn(async () => undefined),
}));

const screenMocks = vi.hoisted(() => ({
  parseScreenRecordPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "mp4",
    durationMs: 300_000,
    fps: 10,
    screenIndex: 0,
    hasAudio: true,
  })),
  screenRecordTempPath: vi.fn(() => "/tmp/screen-record.mp4"),
  writeScreenRecordToFile: vi.fn(async () => ({ path: "/tmp/screen-record.mp4" })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
  readGatewayCallOptions: gatewayMocks.readGatewayCallOptions,
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNodeId: nodeUtilsMocks.resolveNodeId,
  resolveNode: nodeUtilsMocks.resolveNode,
}));

vi.mock("../../cli/nodes-camera.js", () => ({
  cameraTempPath: nodesCameraMocks.cameraTempPath,
  parseCameraClipPayload: nodesCameraMocks.parseCameraClipPayload,
  parseCameraSnapPayload: nodesCameraMocks.parseCameraSnapPayload,
  writeCameraClipPayloadToFile: nodesCameraMocks.writeCameraClipPayloadToFile,
  writeCameraPayloadToFile: nodesCameraMocks.writeCameraPayloadToFile,
}));

vi.mock("../../cli/nodes-screen.js", () => ({
  parseScreenRecordPayload: screenMocks.parseScreenRecordPayload,
  screenRecordTempPath: screenMocks.screenRecordTempPath,
  writeScreenRecordToFile: screenMocks.writeScreenRecordToFile,
}));

let createNodesTool: typeof import("./nodes-tool.js").createNodesTool;

describe("createNodesTool screen_record duration guardrails", () => {
  beforeAll(async () => {
    ({ createNodesTool } = await import("./nodes-tool.js"));
  });

  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReturnValue({});
    nodeUtilsMocks.resolveNodeId.mockClear();
    nodeUtilsMocks.resolveNode.mockClear();
    screenMocks.parseScreenRecordPayload.mockClear();
    screenMocks.writeScreenRecordToFile.mockClear();
    nodesCameraMocks.cameraTempPath.mockClear();
    nodesCameraMocks.parseCameraSnapPayload.mockClear();
    nodesCameraMocks.writeCameraPayloadToFile.mockClear();
  });

  it("marks nodes as owner-only", () => {
    const tool = createNodesTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("caps durationMs schema at 300000", () => {
    const tool = createNodesTool();
    const schema = tool.parameters as {
      properties?: {
        durationMs?: {
          maximum?: number;
        };
      };
    };
    expect(schema.properties?.durationMs?.maximum).toBe(300_000);
  });

  it("clamps screen_record durationMs argument to 300000 before gateway invoke", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "screen_record",
      node: "macbook",
      durationMs: 900_000,
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({
        params: expect.objectContaining({
          durationMs: 300_000,
        }),
      }),
    );
  });

  it("rejects the removed run action", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "run",
        node: "macbook",
      }),
    ).rejects.toThrow("Unknown action: run");
  });
  it("returns camera snaps via details.media.mediaUrls", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });
    const tool = createNodesTool();

    const result = await tool.execute("call-1", {
      action: "camera_snap",
      node: "macbook",
      facing: "front",
    });

    expect(result?.details).toEqual({
      snaps: [
        {
          facing: "front",
          path: "/tmp/camera-front.jpg",
          width: 800,
          height: 600,
        },
      ],
      media: {
        mediaUrls: ["/tmp/camera-front.jpg"],
      },
    });
    expect(JSON.stringify(result?.content ?? [])).not.toContain("MEDIA:");
  });

  it("returns latest photos via details.media.mediaUrls", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: {
        photos: [
          { base64: "ZmFrZQ==", format: "jpg", width: 800, height: 600, createdAt: "now" },
          { base64: "YmFy", format: "jpg", width: 1024, height: 768 },
        ],
      },
    });
    nodesCameraMocks.cameraTempPath
      .mockReturnValueOnce("/tmp/photo-1.jpg")
      .mockReturnValueOnce("/tmp/photo-2.jpg");
    nodesCameraMocks.parseCameraSnapPayload
      .mockReturnValueOnce({
        base64: "ZmFrZQ==",
        format: "jpg",
        width: 800,
        height: 600,
      })
      .mockReturnValueOnce({
        base64: "YmFy",
        format: "jpg",
        width: 1024,
        height: 768,
      });
    const tool = createNodesTool();

    const result = await tool.execute("call-1", {
      action: "photos_latest",
      node: "macbook",
    });

    expect(result?.details).toEqual({
      photos: [
        {
          index: 0,
          path: "/tmp/photo-1.jpg",
          width: 800,
          height: 600,
          createdAt: "now",
        },
        {
          index: 1,
          path: "/tmp/photo-2.jpg",
          width: 1024,
          height: 768,
        },
      ],
      media: {
        mediaUrls: ["/tmp/photo-1.jpg", "/tmp/photo-2.jpg"],
      },
    });
    expect(JSON.stringify(result?.content ?? [])).not.toContain("MEDIA:");
  });

  it("uses operator.admin to approve exec-capable node pair requests", async () => {
    gatewayMocks.callGatewayTool.mockImplementation(async (method, _opts, params, extra) => {
      if (method === "node.pair.list") {
        return {
          pending: [
            {
              requestId: "req-1",
              commands: ["system.run"],
            },
          ],
        };
      }
      if (method === "node.pair.approve") {
        return { ok: true, method, params, extra };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
      1,
      "node.pair.list",
      {},
      {},
      { scopes: ["operator.pairing", "operator.write"] },
    );
    expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "node.pair.approve",
      {},
      { requestId: "req-1" },
      { scopes: ["operator.admin"] },
    );
  });

  it("uses operator.write to approve non-exec node pair requests", async () => {
    gatewayMocks.callGatewayTool.mockImplementation(async (method, _opts, params, extra) => {
      if (method === "node.pair.list") {
        return {
          pending: [
            {
              requestId: "req-1",
              commands: ["canvas.snapshot"],
            },
          ],
        };
      }
      if (method === "node.pair.approve") {
        return { ok: true, method, params, extra };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
      1,
      "node.pair.list",
      {},
      {},
      { scopes: ["operator.pairing", "operator.write"] },
    );
    expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "node.pair.approve",
      {},
      { requestId: "req-1" },
      { scopes: ["operator.write"] },
    );
  });

  it("uses operator.write for commandless node pair requests", async () => {
    gatewayMocks.callGatewayTool.mockImplementation(async (method, _opts, params, extra) => {
      if (method === "node.pair.list") {
        return {
          pending: [
            {
              requestId: "req-1",
            },
          ],
        };
      }
      if (method === "node.pair.approve") {
        return { ok: true, method, params, extra };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "node.pair.approve",
      {},
      { requestId: "req-1" },
      { scopes: ["operator.write"] },
    );
  });

  it("blocks invokeCommand system.run so exec stays the only shell path", async () => {
    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "invoke",
        node: "macbook",
        invokeCommand: "system.run",
      }),
    ).rejects.toThrow('invokeCommand "system.run" is reserved for shell execution');
  });
});
