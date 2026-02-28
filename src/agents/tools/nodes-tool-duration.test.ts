import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECORDING_DURATION_MS } from "./nodes-tool.js";

// ── mocks (hoisted) ────────────────────────────────────────────────
const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));
vi.mock("./gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
  readGatewayCallOptions: gatewayMocks.readGatewayCallOptions,
}));

const nodeMocks = vi.hoisted(() => ({
  resolveNodeId: vi.fn(async () => "node-1"),
}));
vi.mock("./nodes-utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveNodeId: nodeMocks.resolveNodeId };
});

const screenMocks = vi.hoisted(() => ({
  writeScreenRecordToFile: vi.fn(async () => ({ path: "/tmp/screen.mp4" })),
  parseScreenRecordPayload: vi.fn(() => ({
    base64: "",
    durationMs: 10_000,
    fps: 10,
    screenIndex: 0,
    hasAudio: true,
    format: "mp4",
  })),
  screenRecordTempPath: vi.fn(() => "/tmp/screen.mp4"),
}));
vi.mock("../../cli/nodes-screen.js", () => ({
  parseScreenRecordPayload: screenMocks.parseScreenRecordPayload,
  writeScreenRecordToFile: screenMocks.writeScreenRecordToFile,
  screenRecordTempPath: screenMocks.screenRecordTempPath,
}));

const cameraMocks = vi.hoisted(() => ({
  writeCameraClipPayloadToFile: vi.fn(async () => "/tmp/clip.mp4"),
  parseCameraClipPayload: vi.fn(() => ({
    base64: "",
    durationMs: 3_000,
    hasAudio: true,
    format: "mp4",
  })),
}));
vi.mock("../../cli/nodes-camera.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parseCameraClipPayload: cameraMocks.parseCameraClipPayload,
    writeCameraClipPayloadToFile: cameraMocks.writeCameraClipPayloadToFile,
  };
});

import { createNodesTool } from "./nodes-tool.js";

// ── helpers ────────────────────────────────────────────────────────

function makeTool() {
  return createNodesTool({ agentSessionKey: "agent:test:main", config: {} as never });
}

/** Extract the `durationMs` sent to the gateway `node.invoke` call. */
function invokedDurationMs(): number {
  // callGatewayTool is called as: callGatewayTool("node.invoke", opts, { ..., params: { durationMs, ... } })
  const calls = gatewayMocks.callGatewayTool.mock.calls as unknown[][];
  const invokeCall = calls.find((c) => c[0] === "node.invoke");
  expect(invokeCall).toBeDefined();
  const body = invokeCall![2] as { params: { durationMs: number } };
  return body.params.durationMs;
}

// ── tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  gatewayMocks.callGatewayTool.mockReset();
  nodeMocks.resolveNodeId.mockReset().mockResolvedValue("node-1");
  screenMocks.writeScreenRecordToFile.mockReset().mockResolvedValue({ path: "/tmp/screen.mp4" });
  screenMocks.parseScreenRecordPayload.mockReset().mockReturnValue({
    base64: "",
    durationMs: 10_000,
    fps: 10,
    screenIndex: 0,
    hasAudio: true,
    format: "mp4",
  });
  cameraMocks.writeCameraClipPayloadToFile.mockReset().mockResolvedValue("/tmp/clip.mp4");
  cameraMocks.parseCameraClipPayload.mockReset().mockReturnValue({
    base64: "",
    durationMs: 3_000,
    hasAudio: true,
    format: "mp4",
  });
  // Default: node.invoke returns a payload
  gatewayMocks.callGatewayTool.mockResolvedValue({ payload: {} });
});

describe("MAX_RECORDING_DURATION_MS constant", () => {
  it("equals 5 minutes", () => {
    expect(MAX_RECORDING_DURATION_MS).toBe(300_000);
  });
});

describe("screen_record duration clamping (production path)", () => {
  it("clamps excessively large durationMs to MAX_RECORDING_DURATION_MS", async () => {
    const tool = makeTool();
    await tool.execute("c1", { action: "screen_record", node: "my-node", durationMs: 86_400_000 });
    expect(invokedDurationMs()).toBe(MAX_RECORDING_DURATION_MS);
  });

  it("clamps sub-second durationMs to 1 000 ms floor", async () => {
    const tool = makeTool();
    await tool.execute("c2", { action: "screen_record", node: "my-node", durationMs: 200 });
    expect(invokedDurationMs()).toBe(1_000);
  });

  it("passes through a valid durationMs unchanged", async () => {
    const tool = makeTool();
    await tool.execute("c3", { action: "screen_record", node: "my-node", durationMs: 60_000 });
    expect(invokedDurationMs()).toBe(60_000);
  });

  it("clamps duration string that exceeds the max", async () => {
    const tool = makeTool();
    await tool.execute("c4", { action: "screen_record", node: "my-node", duration: "1h" });
    expect(invokedDurationMs()).toBe(MAX_RECORDING_DURATION_MS);
  });
});

describe("camera_clip duration clamping (production path)", () => {
  it("clamps excessively large durationMs to MAX_RECORDING_DURATION_MS", async () => {
    const tool = makeTool();
    await tool.execute("c5", { action: "camera_clip", node: "my-node", durationMs: 600_000 });
    expect(invokedDurationMs()).toBe(MAX_RECORDING_DURATION_MS);
  });

  it("clamps sub-second durationMs to 1 000 ms floor", async () => {
    const tool = makeTool();
    await tool.execute("c6", { action: "camera_clip", node: "my-node", durationMs: 0 });
    expect(invokedDurationMs()).toBe(1_000);
  });

  it("passes through a valid durationMs unchanged", async () => {
    const tool = makeTool();
    await tool.execute("c7", { action: "camera_clip", node: "my-node", durationMs: 30_000 });
    expect(invokedDurationMs()).toBe(30_000);
  });
});
