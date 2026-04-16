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

const nodesFileMocks = vi.hoisted(() => ({
  parseFileReadPayload: vi.fn((v: unknown) => v),
  fileTempPath: vi.fn(() => "/tmp/openclaw-file-transfer-test.bin"),
  writeFilePayloadToFile: vi.fn(async () => ({
    path: "/tmp/openclaw-file-transfer-test.bin",
    size: 5,
  })),
}));

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => Buffer.from("hello")),
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

vi.mock("../../cli/nodes-file.js", () => ({
  parseFileReadPayload: nodesFileMocks.parseFileReadPayload,
  fileTempPath: nodesFileMocks.fileTempPath,
  writeFilePayloadToFile: nodesFileMocks.writeFilePayloadToFile,
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: fsMocks.readFile },
  readFile: fsMocks.readFile,
}));

vi.mock("../../cli/nodes-screen.js", () => ({
  parseScreenRecordPayload: screenMocks.parseScreenRecordPayload,
  screenRecordTempPath: screenMocks.screenRecordTempPath,
  writeScreenRecordToFile: screenMocks.writeScreenRecordToFile,
}));

let createNodesTool: typeof import("./nodes-tool.js").createNodesTool;

function mockNodePairApproveFlow(pendingRequest: {
  requiredApproveScopes?: string[];
  commands?: string[];
}): void {
  gatewayMocks.callGatewayTool.mockImplementation(async (method, _opts, params, extra) => {
    if (method === "node.pair.list") {
      return {
        pending: [
          {
            requestId: "req-1",
            ...pendingRequest,
          },
        ],
      };
    }
    if (method === "node.pair.approve") {
      return { ok: true, method, params, extra };
    }
    throw new Error(`unexpected method: ${String(method)}`);
  });
}

function expectNodePairApproveScopes(scopes: string[]): void {
  expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
    1,
    "node.pair.list",
    {},
    {},
    { scopes: ["operator.pairing"] },
  );
  expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
    2,
    "node.pair.approve",
    {},
    { requestId: "req-1" },
    { scopes },
  );
}

describe("createNodesTool screen_record duration guardrails", () => {
  beforeAll(async () => {
    // The agents lane runs on the shared non-isolated runner, so clear any
    // cached prior import before wiring this file's gateway/media mocks.
    vi.resetModules();
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
    nodesFileMocks.parseFileReadPayload.mockClear();
    nodesFileMocks.fileTempPath.mockClear();
    nodesFileMocks.writeFilePayloadToFile.mockClear();
    fsMocks.readFile.mockClear();
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

  it("uses operator.pairing plus operator.admin to approve exec-capable node pair requests", async () => {
    mockNodePairApproveFlow({
      requiredApproveScopes: ["operator.pairing", "operator.admin"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing", "operator.admin"]);
  });

  it("uses operator.pairing plus operator.write to approve non-exec node pair requests", async () => {
    mockNodePairApproveFlow({
      requiredApproveScopes: ["operator.pairing", "operator.write"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing", "operator.write"]);
  });

  it("uses operator.pairing for commandless node pair requests", async () => {
    mockNodePairApproveFlow({
      requiredApproveScopes: ["operator.pairing"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing"]);
  });

  it("falls back to command inspection when the gateway does not advertise required scopes", async () => {
    mockNodePairApproveFlow({
      commands: ["canvas.snapshot"],
    });
    const tool = createNodesTool();

    await tool.execute("call-1", {
      action: "approve",
      requestId: "req-1",
    });

    expectNodePairApproveScopes(["operator.pairing", "operator.write"]);
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

  it("keeps invoke pairing guidance for scope upgrade rejections", async () => {
    gatewayMocks.callGatewayTool.mockRejectedValueOnce(
      new Error("scope upgrade pending approval (requestId: req-123)"),
    );

    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "invoke",
        node: "macbook",
        invokeCommand: "device.status",
      }),
    ).rejects.toThrow(
      "pairing required before node invoke. Approve pairing request req-123 and retry.",
    );
  });

  it("file_pull returns FILE: prefixed path on success", async () => {
    const fakePayload = {
      path: "/remote/doc.txt",
      encoding: "base64",
      data: "aGVsbG8=",
      size: 5,
    };
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: fakePayload });
    nodesFileMocks.parseFileReadPayload.mockReturnValue(fakePayload);
    nodesFileMocks.fileTempPath.mockReturnValue("/tmp/openclaw-file-transfer-test.txt");
    nodesFileMocks.writeFilePayloadToFile.mockResolvedValue({
      path: "/tmp/openclaw-file-transfer-test.txt",
      size: 5,
    });

    const tool = createNodesTool();
    const result = await tool.execute("call-1", {
      action: "file_pull",
      node: "macbook",
      remotePath: "/remote/doc.txt",
    });

    expect(result?.content).toEqual([
      { type: "text", text: "FILE:/tmp/openclaw-file-transfer-test.txt" },
    ]);
    expect(result?.details).toMatchObject({
      remotePath: "/remote/doc.txt",
      localPath: "/tmp/openclaw-file-transfer-test.txt",
      size: 5,
    });
  });

  it("file_pull rejects oversized files", async () => {
    const oversizedPayload = {
      path: "/remote/huge.bin",
      encoding: "base64",
      data: "x",
      size: 128 * 1024 * 1024,
    };
    gatewayMocks.callGatewayTool.mockResolvedValue({ payload: oversizedPayload });
    nodesFileMocks.parseFileReadPayload.mockReturnValue(oversizedPayload);

    const tool = createNodesTool();

    await expect(
      tool.execute("call-1", {
        action: "file_pull",
        node: "macbook",
        remotePath: "/remote/huge.bin",
      }),
    ).rejects.toThrow(/exceeds max/i);
  });

  it("file_push with localPath invokes node.invoke with file.write", async () => {
    fsMocks.readFile.mockResolvedValue(Buffer.from("hello"));
    gatewayMocks.callGatewayTool.mockResolvedValue({ ok: true });

    const tool = createNodesTool();
    const result = await tool.execute("call-1", {
      action: "file_push",
      node: "macbook",
      remotePath: "/remote/doc.txt",
      localPath: "/local/doc.txt",
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({
        command: "file.write",
        params: expect.objectContaining({
          path: "/remote/doc.txt",
          encoding: "base64",
        }),
      }),
    );
    const parsed = JSON.parse((result?.content as Array<{ text: string }>)?.[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.remotePath).toBe("/remote/doc.txt");
  });

  it("file_push with inline data skips file read", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({ ok: true });

    const tool = createNodesTool();
    await tool.execute("call-1", {
      action: "file_push",
      node: "macbook",
      remotePath: "/remote/config.json",
      data: '{"key":"value"}',
    });

    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({
        command: "file.write",
        params: expect.objectContaining({
          path: "/remote/config.json",
          data: '{"key":"value"}',
          encoding: "utf8",
        }),
      }),
    );
  });
});
