import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool:
    vi.fn<
      (
        method: string,
        opts: unknown,
        params?: unknown,
        extra?: unknown,
      ) => Promise<{ payload?: unknown }>
    >(),
  readGatewayCallOptions: vi.fn<(params: Record<string, unknown>) => Record<string, unknown>>(
    () => ({}),
  ),
}));

const nodeUtilsMocks = vi.hoisted(() => ({
  resolveNodeId: vi.fn<(opts: unknown, query?: string, allowDefault?: boolean) => Promise<string>>(
    async () => "node-1",
  ),
  listNodes: vi.fn<(opts: unknown) => Promise<unknown[]>>(async () => []),
  resolveNodeIdFromList: vi.fn<(nodes: unknown, query?: string, allowDefault?: boolean) => string>(
    () => "node-1",
  ),
}));

const screenMocks = vi.hoisted(() => ({
  parseScreenRecordPayload: vi.fn<(value: unknown) => Record<string, unknown>>(() => ({
    base64: "ZmFrZQ==",
    format: "mp4",
    durationMs: 300_000,
    fps: 10,
    screenIndex: 0,
    hasAudio: true,
  })),
  screenRecordTempPath: vi.fn<(opts: unknown) => string>(() => "/tmp/screen-record.mp4"),
  writeScreenRecordToFile: vi.fn<(filePath: string, base64: string) => Promise<{ path: string }>>(
    async () => ({ path: "/tmp/screen-record.mp4" }),
  ),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
  readGatewayCallOptions: gatewayMocks.readGatewayCallOptions,
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNodeId: nodeUtilsMocks.resolveNodeId,
  listNodes: nodeUtilsMocks.listNodes,
  resolveNodeIdFromList: nodeUtilsMocks.resolveNodeIdFromList,
}));

vi.mock("../../cli/nodes-screen.js", () => ({
  parseScreenRecordPayload: screenMocks.parseScreenRecordPayload,
  screenRecordTempPath: screenMocks.screenRecordTempPath,
  writeScreenRecordToFile: screenMocks.writeScreenRecordToFile,
}));

import { createNodesTool } from "./nodes-tool.js";

describe("createNodesTool screen_record duration guardrails", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReturnValue({});
    nodeUtilsMocks.resolveNodeId.mockClear();
    screenMocks.parseScreenRecordPayload.mockClear();
    screenMocks.writeScreenRecordToFile.mockClear();
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
});
