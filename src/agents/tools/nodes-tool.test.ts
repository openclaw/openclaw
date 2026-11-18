import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

const nodeUtilsMocks = vi.hoisted(() => ({
  resolveAgentNodeId: vi.fn(async () => "node-1"),
  resolveAgentNode: vi.fn(async () => ({
    nodeId: "node-1",
    remoteIp: "127.0.0.1",
    platform: undefined as string | undefined,
  })),
}));

const nodesCameraMocks = vi.hoisted(() => ({
  cameraTempPath: vi.fn(({ facing }: { facing?: string }) =>
    facing ? `/tmp/camera-${facing}.jpg` : "/tmp/camera.jpg",
  ),
  parseCameraClipPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "mp4",
    durationMs: 3000,
    hasAudio: true,
  })),
  parseCameraSnapPayload: vi.fn(() => ({
    base64: "ZmFrZQ==",
    format: "jpg",
    width: 800,
    height: 600,
  })),
  resolveCameraClipTarget: vi.fn((params: { facing: "front" | "back"; platform?: string }) =>
    params.platform === "linux"
      ? { artifactFacing: "unknown" }
      : { requestFacing: params.facing, artifactFacing: params.facing },
  ),
  writeCameraClipPayloadToFile: vi.fn(async ({ facing }: { facing?: string }) =>
    facing ? `/tmp/camera-${facing}.mp4` : "/tmp/camera.mp4",
  ),
  writeCameraPayloadToFile: vi.fn(async () => undefined),
  // This suite isolates tool orchestration; rollback ownership has real-filesystem coverage.
  withCameraArtifactBatch: vi.fn(
    async (paths: string[], publish: (paths: string[]) => Promise<unknown>) => publish(paths),
  ),
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
  writeScreenRecordToFile: vi.fn(async (_filePath: string) => ({
    path: "/tmp/screen-record.mp4",
  })),
  // Mirrors nodes-screen's mapping; the real contract is covered in nodes-camera.test.ts.
  screenSnapshotFormatForPath: vi.fn((filePath: string) => {
    if (filePath.toLowerCase().endsWith(".png")) {
      return "png";
    }
    return /\.jpe?g$/iu.test(filePath) ? "jpeg" : undefined;
  }),
  screenSnapshotTempPath: vi.fn(() => "/tmp/screen-snapshot.png"),
  writeScreenSnapshotToFile: vi.fn(async (_filePath: string) => ({
    path: "/tmp/screen-snapshot.png",
  })),
}));

// mock-isolation: Supply deterministic node identity and Gateway responses without a live connection.
vi.mock("./gateway.js", () => gatewayMocks);
// mock-isolation: Supply deterministic node identity and Gateway responses without a live connection.
vi.mock("./nodes-utils.js", () => nodeUtilsMocks);
// mock-isolation: Keep host camera and screen capture outside node-tool dispatch proof.
vi.mock("../../cli/nodes-camera.js", async (importOriginal) => ({
  ...nodesCameraMocks,
  resolveCameraSnapTargets: (await importOriginal<typeof import("../../cli/nodes-camera.js")>())
    .resolveCameraSnapTargets,
}));
// mock-isolation: Keep host camera and screen capture outside node-tool dispatch proof.
vi.mock("../../cli/nodes-screen.js", () => screenMocks);

let createNodesTool: typeof import("./nodes-tool.js").createNodesTool;
let extractToolResultMediaArtifact: typeof import("../embedded-agent-tool-media.js").extractToolResultMediaArtifact;

function onNode(
  action: string,
  params: Record<string, unknown> = {},
  options?: Parameters<typeof createNodesTool>[0],
) {
  return createNodesTool(options).execute("call", { action, node: "macbook", ...params });
}
const gatewayPayload = (payload: unknown = { ok: true }) =>
  gatewayMocks.callGatewayTool.mockResolvedValue({ payload });
const snapshot = { base64: "ZmFrZQ==", format: "png", screenIndex: 0, width: 1920, height: 1080 };
const photo = { base64: "ZmFrZQ==", format: "jpg", width: 800, height: 600 };

function mockNodePairApproveFlow(pendingRequest: {
  requiredApproveScopes?: string[];
  commands?: string[];
}): void {
  // Pairing approval is two-step by design: list pending requests under the
  // operator scope, then approve with the request's required scopes.
  gatewayMocks.callGatewayTool.mockImplementation(async (method, _opts, params, extra) => {
    if (method === "node.pair.list") {
      return { pending: [{ requestId: "req-1", ...pendingRequest }] };
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

beforeAll(async () => {
  // The agents lane runs on the shared non-isolated runner, so clear any
  // cached prior import before wiring this file's gateway/media mocks.
  vi.resetModules();
  ({ createNodesTool } = await import("./nodes-tool.js"));
  ({ extractToolResultMediaArtifact } = await import("../embedded-agent-tool-media.js"));
});

beforeEach(() => {
  // Vitest restores vi.fn(implementation) to that implementation on mockReset.
  for (const group of [gatewayMocks, nodeUtilsMocks, screenMocks, nodesCameraMocks]) {
    for (const mock of Object.values(group)) {
      mock.mockReset();
    }
  }
});

it.each<[string, Record<string, unknown>, string, Parameters<typeof createNodesTool>[0]?]>([
  [
    "describe",
    { node: undefined },
    'node required for describe; call nodes with action="status" to list nodes, then retry with node',
  ],
  ["notify", { node: "Office Mac", title: " \t ", body: " \n " }, "title or body required"],
  ["run", {}, "Unknown action: run"],
  ["camera_snap", { quality: 1.1 }, "quality must be between 0 and 1"],
  ["photos_latest", { quality: -0.1 }, "quality must be between 0 and 1"],
  ["screen_record", { fps: 0 }, "fps must be greater than 0"],
  ["location_get", { locationTimeoutMs: 0 }, "locationTimeoutMs must be a positive integer"],
  [
    "invoke",
    { invokeCommand: "device.status", invokeTimeoutMs: "15s" },
    "invokeTimeoutMs must be a positive integer",
  ],
  ["which", {}, "bins required"],
  [
    "invoke",
    { invokeCommand: "system.run" },
    'invokeCommand "system.run" is reserved for shell execution',
  ],
  [
    "invoke",
    { invokeCommand: "computer.act", invokeParamsJson: '{"action":"left_click","x":1,"y":1}' },
    "use the dedicated computer tool",
  ],
  [
    "invoke",
    { node: "pixel", invokeCommand: "mobile.ui.act", invokeParamsJson: "{}" },
    "use the dedicated mobile_ui tool",
  ],
  [
    "invoke",
    {
      invokeCommand: "browser.proxy",
      invokeParamsJson:
        '{"method":"POST","path":"/act","body":{"kind":"click","ref":"e3","targetId":"T1"}}',
    },
    "use the dedicated browser tool",
  ],
  [
    "invoke",
    { node: "pixel", invokeCommand: "browser.proxy.upload.v1", invokeParamsJson: "{}" },
    "use the dedicated browser tool",
  ],
  [
    "invoke",
    { invokeCommand: "file.fetch" },
    'invokeCommand "file.fetch" enforces a path-allowlist policy and cannot be invoked via the generic nodes.invoke surface; use the dedicated file-transfer tool "file_fetch"',
    { allowMediaInvokeCommands: true },
  ],
  ["invoke", { invokeCommand: "screen.snapshot" }, 'use action="screen_snapshot"'],
])("rejects %s %j before gateway invocation", async (action, params, message, options) => {
  await expect(onNode(action, params, options)).rejects.toThrow(message);
  expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
  if (action === "describe") {
    expect(nodeUtilsMocks.resolveAgentNodeId).not.toHaveBeenCalled();
  }
});

it("bounds durationMs schema to positive values capped at 300000", () => {
  expect(createNodesTool().parameters).toMatchObject({
    properties: { durationMs: { type: "integer", minimum: 1, maximum: 300_000 } },
  });
});

it("resolves and describes the explicit node", async () => {
  gatewayMocks.callGatewayTool.mockResolvedValue({ nodeId: "node-1" });
  await onNode("describe", { node: "Office Mac" });

  expect(nodeUtilsMocks.resolveAgentNodeId).toHaveBeenCalledWith({}, "Office Mac");
  expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
    "node.describe",
    {},
    { nodeId: "node-1" },
  );
});

it.each([
  { name: "title only", input: { title: "Build complete" } },
  { name: "body only", input: { body: "Deployment finished" } },
])("serializes both required native strings for $name", async ({ input }) => {
  gatewayPayload();
  await onNode("notify", {
    node: "Office Mac",
    ...input,
    sound: "ding.aiff",
    priority: "timeSensitive",
    delivery: "overlay",
  });

  expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
    "node.invoke",
    {},
    {
      nodeId: "node-1",
      command: "system.notify",
      params: {
        title: (input.title ?? "").trim(),
        body: (input.body ?? "").trim(),
        sound: "ding.aiff",
        priority: "timeSensitive",
        delivery: "overlay",
      },
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    },
  );
});

it.each(["screen_record", "camera_clip"])(
  "clamps %s to the tool duration limit and budgets both timeout layers",
  async (action) => {
    gatewayPayload();
    nodesCameraMocks.parseCameraClipPayload.mockReturnValue({
      base64: "ZmFrZQ==",
      format: "mp4",
      durationMs: 300_000,
      hasAudio: true,
    });
    nodesCameraMocks.writeCameraClipPayloadToFile.mockResolvedValue("/tmp/clip.mp4");
    await onNode(action, { durationMs: 900_000 });
    expect(gatewayMocks.callGatewayTool.mock.calls[0]).toStrictEqual([
      "node.invoke",
      { timeoutMs: 360_000 },
      expect.objectContaining({
        params: expect.objectContaining({ durationMs: 300_000 }),
        timeoutMs: 330_000,
      }),
    ]);
  },
);

it.each([
  {
    action: "invoke",
    input: { invokeCommand: "device.status", invokeTimeoutMs: 60_000 },
    invokeTimeoutMs: 60_000,
    transportTimeoutMs: 90_000,
  },
  {
    action: "location_get",
    input: { locationTimeoutMs: 60_000 },
    invokeTimeoutMs: 90_000,
    transportTimeoutMs: 120_000,
  },
])(
  "allows long $action operations through both timeout layers",
  async ({ action, input, invokeTimeoutMs, transportTimeoutMs }) => {
    gatewayPayload();
    await onNode(action, input);

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: transportTimeoutMs },
      expect.objectContaining({ timeoutMs: invokeTimeoutMs }),
    );
  },
);

it("invokes screen.snapshot with validated params and returns file details", async () => {
  gatewayPayload(snapshot);
  const result = await onNode("screen_snapshot", { screenIndex: 1, maxWidth: "1200" });

  expect(gatewayMocks.callGatewayTool).toHaveBeenCalledTimes(1);
  expect(gatewayMocks.callGatewayTool.mock.calls[0]).toEqual([
    "node.invoke",
    expect.anything(),
    expect.objectContaining({
      command: "screen.snapshot",
      params: { screenIndex: 1, maxWidth: 1200, format: undefined },
    }),
  ]);
  expect(screenMocks.screenSnapshotTempPath).toHaveBeenCalledWith({ ext: "png" });
  expect(screenMocks.writeScreenSnapshotToFile).toHaveBeenCalledWith(
    "/tmp/screen-snapshot.png",
    "ZmFrZQ==",
  );
  expect(result).toEqual({
    content: [{ type: "text", text: "FILE:/tmp/screen-snapshot.png" }],
    details: {
      path: "/tmp/screen-snapshot.png",
      format: "png",
      screenIndex: 0,
      width: 1920,
      height: 1080,
      media: { mediaUrl: "/tmp/screen-snapshot.png", outbound: false },
    },
  });
});

it("requests the encoding a caller-supplied outPath already promises", async () => {
  gatewayPayload({ base64: "ZmFrZQ==", format: "png" });
  screenMocks.writeScreenSnapshotToFile.mockImplementationOnce(async (filePath: string) => ({
    path: filePath,
  }));
  const result = await onNode("screen_snapshot", {
    node: "miniclaw",
    outPath: "/workspace/miniclaw-screen-2026-07-28.png",
  });

  // Without this the node falls back to its own default (JPEG on macOS) and a
  // `.png` request quietly receives JPEG bytes.
  expect(gatewayMocks.callGatewayTool.mock.calls[0]?.[2].params.format).toBe("png");
  // The workspace guard alias-checked this exact path; it is written verbatim.
  expect(screenMocks.writeScreenSnapshotToFile).toHaveBeenCalledWith(
    "/workspace/miniclaw-screen-2026-07-28.png",
    "ZmFrZQ==",
  );
  expect(screenMocks.screenSnapshotTempPath).not.toHaveBeenCalled();
  expect(result.content).toEqual([
    { type: "text", text: "FILE:/workspace/miniclaw-screen-2026-07-28.png" },
  ]);
});

it("refuses to write snapshot bytes that contradict the outPath extension", async () => {
  // A node that ignores the requested format must not silently mislabel the file.
  gatewayPayload({ ...snapshot, format: "jpeg" });
  await expect(
    onNode("screen_snapshot", { node: "miniclaw", outPath: "/workspace/shot.png" }),
  ).rejects.toThrow("screen.snapshot returned jpg; outPath must use a matching extension");
  expect(screenMocks.writeScreenSnapshotToFile).not.toHaveBeenCalled();
});

it("rejects a positioned camera device with both facings before invoking the node", async () => {
  await expect(
    onNode("camera_snap", { facing: "both", deviceId: "camera-device" }),
  ).rejects.toThrow("facing=both is not allowed when deviceId is set");
  expect(gatewayMocks.callGatewayTool).not.toHaveBeenCalled();
});

it.each([
  ["camera_snap", "both", { snaps: [{ facing: "unknown", path: "/tmp/camera-unknown.jpg" }] }],
  ["camera_clip", "back", { facing: "unknown", path: "/tmp/camera-unknown.mp4" }],
] as const)("captures %s on Linux without forwarding facing", async (action, facing, details) => {
  nodeUtilsMocks.resolveAgentNode.mockResolvedValueOnce({
    nodeId: "linux-node",
    remoteIp: "127.0.0.1",
    platform: "linux",
  });
  gatewayPayload();
  const result = await onNode(action, {
    node: "linux-node",
    facing,
    deviceId: "/dev/video2",
  });

  expect(gatewayMocks.callGatewayTool).toHaveBeenCalledTimes(1);
  expect(gatewayMocks.callGatewayTool.mock.calls[0]?.[2]).toMatchObject({
    command: action.replace("_", "."),
    params: { facing: undefined, deviceId: "/dev/video2" },
  });
  expect(result?.details).toMatchObject(details);
});

it("returns latest photos via details.media.mediaUrls", async () => {
  gatewayPayload({
    photos: [
      { ...photo, createdAt: "now" },
      { base64: "YmFy", format: "jpg", width: 1024, height: 768 },
    ],
  });
  nodesCameraMocks.cameraTempPath
    .mockReturnValueOnce("/tmp/photo-1.jpg")
    .mockReturnValueOnce("/tmp/photo-2.jpg");
  nodesCameraMocks.parseCameraSnapPayload
    .mockReturnValueOnce(photo)
    .mockReturnValueOnce({ base64: "YmFy", format: "jpg", width: 1024, height: 768 });
  const result = await onNode("photos_latest", { limit: 2 });

  expect(result?.details).toEqual({
    photos: [
      { index: 0, path: "/tmp/photo-1.jpg", width: 800, height: 600, createdAt: "now" },
      { index: 1, path: "/tmp/photo-2.jpg", width: 1024, height: 768 },
    ],
    media: { mediaUrls: ["/tmp/photo-1.jpg", "/tmp/photo-2.jpg"], outbound: false },
  });
  expect(JSON.stringify(result?.content ?? [])).not.toContain("MEDIA:");
});

it("keeps inspected photos private (not auto-attached to replies)", async () => {
  gatewayPayload({ photos: [photo] });
  const tool = createNodesTool({ modelHasVision: true });

  const result = await tool.execute("call-privacy", {
    action: "photos_latest",
    node: "macbook",
  });

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("MEDIA:");
  // When image sanitization omits the dummy base64 block, the result text
  // still carries the saved path without claiming images were loaded.
  const texts = (result?.content ?? [])
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  expect(texts).toContain('Photo saved to "/tmp/camera.jpg"; not attached or sent to the user.');
  expect(texts).not.toContain("loaded into private model context");
  expect((result?.details as { media?: unknown })?.media).toMatchObject({ outbound: false });
  expect(extractToolResultMediaArtifact(result)).toBeUndefined();
});

it("does not claim photos were loaded into model context when modelHasVision is false", async () => {
  gatewayPayload({ photos: [photo] });
  const result = await onNode("photos_latest", {}, { modelHasVision: false });

  expect(result?.content).toEqual([
    { type: "text", text: "Library photo saved to /tmp/camera.jpg." },
  ]);
  expect((result?.details as { media?: unknown })?.media).toMatchObject({ outbound: false });
  expect(extractToolResultMediaArtifact(result)).toBeUndefined();
});

it("caps photos_latest limit at 20 before gateway invoke", async () => {
  gatewayPayload({ photos: [] });
  await onNode("photos_latest", { limit: 99 });
  expect(gatewayMocks.callGatewayTool.mock.calls[0]).toEqual([
    "node.invoke",
    expect.anything(),
    expect.objectContaining({ params: expect.objectContaining({ limit: 20 }) }),
  ]);
});

it("forwards validated camera_snap numeric params to gateway invoke", async () => {
  gatewayPayload();
  await onNode("camera_snap", {
    facing: "front",
    maxWidth: "640",
    quality: "0.8",
    delayMs: "2000",
  });

  expect(gatewayMocks.callGatewayTool.mock.calls[0]).toEqual([
    "node.invoke",
    expect.anything(),
    expect.objectContaining({
      params: expect.objectContaining({ maxWidth: 640, quality: 0.8, delayMs: 2000 }),
    }),
  ]);
});

it("preserves explicit null location_get payloads from node.invoke", async () => {
  gatewayPayload(null);
  const result = await onNode("location_get");

  expect(result.details).toBeNull();
  expect(result.content).toEqual([{ type: "text", text: "null" }]);
});

it("forwards typed which bins to system.which", async () => {
  gatewayPayload({ bins: ["hostname"], paths: { hostname: "/bin/hostname" } });
  const result = await onNode("which", { bins: ["hostname"] });

  expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
    "node.invoke",
    {},
    {
      nodeId: "node-1",
      command: "system.which",
      params: { bins: ["hostname"] },
      idempotencyKey: expect.any(String),
    },
  );
  expect(result.details).toEqual({ bins: ["hostname"], paths: { hostname: "/bin/hostname" } });
});

it.each([
  {
    request: { requiredApproveScopes: ["operator.pairing", "operator.admin"] },
    scope: "operator.admin",
  },
  { request: { commands: ["canvas.snapshot"] }, scope: "operator.write" },
])("approves node pair requests using $scope", async ({ request, scope }) => {
  mockNodePairApproveFlow(request);
  await createNodesTool().execute("call", { action: "approve", requestId: "req-1" });

  expectNodePairApproveScopes(["operator.pairing", scope]);
});

it("forwards the owning agent session for generic node invokes", async () => {
  gatewayPayload();
  await onNode(
    "invoke",
    { invokeCommand: "device.status" },
    { agentSessionKey: "agent:main:canvas" },
  );

  expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
    "node.invoke",
    {},
    expect.objectContaining({ command: "device.status", sessionKey: "agent:main:canvas" }),
  );
});

it("keeps invoke pairing guidance for scope upgrade rejections", async () => {
  gatewayMocks.callGatewayTool.mockRejectedValueOnce(
    new Error("scope upgrade pending approval (requestId: req-123)"),
  );
  await expect(onNode("invoke", { invokeCommand: "device.status" })).rejects.toThrow(
    "pairing required before node invoke. Approve pairing request req-123 and retry.",
  );
});
