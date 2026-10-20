import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  callGatewayToolMock,
  COMPUTER_ACT_COMMAND,
  type ComputerActBody,
  type ComputerTool,
  type ComputerToolOptions,
  createVisionComputerTool,
  EFFECTIVE_REF_WIDTH,
  listNodesMock,
  macComputerNode,
  readFrameId,
  readLastComputerActParams,
  resetComputerToolMocks,
  screenshotPayload,
  TINY_PNG_BASE64,
} from "./computer-tool.test-helpers.js";

const INVALID_SCROLL_AMOUNT = /scrollAmount must be a positive integer/;
const INVALID_HOLD_DURATION = /duration must be >0 and <=10 seconds/;

function expectedAct(action: string, fields: Record<string, unknown> = {}) {
  return { action, screenIndex: 0, refWidth: EFFECTIVE_REF_WIDTH, ...fields };
}

function twoMacComputerNodes() {
  return [
    macComputerNode({ nodeId: "mac-a" }),
    macComputerNode({ nodeId: "mac-b", displayName: "Studio B" }),
  ];
}

function computerActBodies(): ComputerActBody[] {
  return callGatewayToolMock.mock.calls
    .map((call) => call[2] as ComputerActBody)
    .filter((body) => body.command === COMPUTER_ACT_COMMAND)
    .map((body) => {
      if (!body.params) {
        return body;
      }
      const { executionId: _executionId, ...params } = body.params;
      const sanitizedBody = Object.assign({}, body);
      sanitizedBody.params = params;
      return sanitizedBody;
    });
}

async function captureFrame(
  tool: ComputerTool,
  input: Record<string, unknown> = {},
  callId = "shot",
) {
  return readFrameId(await tool.execute(callId, { action: "screenshot", ...input }));
}

async function createToolWithFrame(
  options: ComputerToolOptions = {},
  input: Record<string, unknown> = {},
  callId = "shot",
) {
  const tool = createVisionComputerTool(options);
  return { tool, frameId: await captureFrame(tool, input, callId) };
}

function executeClick(
  tool: ComputerTool,
  frameId: string,
  input: Record<string, unknown> = {},
  callId = "click",
  signal?: AbortSignal,
) {
  return tool.execute(
    callId,
    { action: "left_click", coordinate: [1, 2], frameId, ...input },
    signal,
  );
}

function executeMouseDown(
  tool: ComputerTool,
  frameId: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return executeClick(tool, frameId, { action: "left_mouse_down", ...input }, "down", signal);
}

function retargetToMacB(tool: ComputerTool, callId = "retarget") {
  return tool.execute(callId, { action: "screenshot", node: "mac-b" });
}

type InvalidCase = [string, Record<string, unknown>, RegExp];

function invalidScrollCase(name: string, scrollAmount: unknown): InvalidCase {
  return [name, { action: "scroll", scrollDirection: "down", scrollAmount }, INVALID_SCROLL_AMOUNT];
}

function invalidHoldCase(name: string, duration: unknown): InvalidCase {
  return [name, { action: "hold_key", text: "space", duration }, INVALID_HOLD_DURATION];
}

async function rejectsClick(
  tool: ComputerTool,
  frameId: string,
  error: string | RegExp,
  input: Record<string, unknown> = {},
  callId = "click",
) {
  await expect(executeClick(tool, frameId, input, callId)).rejects.toThrow(error);
}

function mockComputerActError(error: Error, action?: string) {
  callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
    const request = body as ComputerActBody;
    if (
      request.command === COMPUTER_ACT_COMMAND &&
      (!action || request.params?.action === action)
    ) {
      throw error;
    }
    return request.command === COMPUTER_ACT_COMMAND
      ? { payload: { ok: true } }
      : screenshotPayload();
  });
}

function mockFirstScreenshotThenFailure(screenIndex = 0) {
  let screenshotCalls = 0;
  callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
    if ((body as ComputerActBody).command === COMPUTER_ACT_COMMAND) {
      return { payload: { ok: true } };
    }
    if ((screenshotCalls += 1) === 1) {
      return screenshotPayload(screenIndex);
    }
    throw new Error("capture failed");
  });
}

async function executeComputerAction(params: Record<string, unknown>) {
  const tool = createVisionComputerTool();
  const actionParams = { ...params };
  if (Object.hasOwn(params, "coordinate") || Object.hasOwn(params, "startCoordinate")) {
    const screenshot = await tool.execute("shot", { action: "screenshot" });
    actionParams.frameId = readFrameId(screenshot);
  }
  await tool.execute("act", actionParams);
  return readLastComputerActParams();
}

describe("createComputerTool v1 execution", () => {
  beforeEach(resetComputerToolMocks);

  it.each([
    [
      "maps left click through the computer.act execution path",
      { action: "left_click", coordinate: [12, 34], text: "shift" },
      expectedAct("left_click", {
        displayFrameId: "display-0-frame",
        x: 12,
        y: 34,
        modifiers: "shift",
      }),
    ],
    [
      "maps drag through the computer.act execution path",
      { action: "left_click_drag", startCoordinate: [1, 2], coordinate: [3, 4] },
      expectedAct("left_click_drag", {
        displayFrameId: "display-0-frame",
        fromX: 1,
        fromY: 2,
        x: 3,
        y: 4,
      }),
    ],
    [
      "maps key input without leaking pointer fields",
      { action: "key", text: "cmd+shift+t" },
      expectedAct("key", { keys: "cmd+shift+t" }),
    ],
    [
      "maps hold key input without leaking pointer fields",
      { action: "hold_key", text: "space", duration: 10 },
      expectedAct("hold_key", { keys: "space", durationMs: 10_000 }),
    ],
  ])("%s", async (_name, params, expected) => {
    await expect(executeComputerAction(params)).resolves.toEqual(expected);
  });

  it("requires coordinates through the public execution path", async () => {
    const { tool, frameId } = await createToolWithFrame();

    await expect(tool.execute("act", { action: "double_click", frameId })).rejects.toThrow(
      /coordinate/,
    );
    expect(() => readLastComputerActParams()).toThrow(/missing computer\.act request/);
  });

  it("rejects malformed required coordinate input", async () => {
    await expect(
      executeComputerAction({ action: "left_click", coordinate: [-1, 2] }),
    ).rejects.toThrow(/coordinate/);
  });

  it("omits an unchanged screenshot while retaining its frame and refreshing node coordinates", async () => {
    let screenshotCalls = 0;
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as ComputerActBody).command === COMPUTER_ACT_COMMAND) {
        return { payload: { ok: true } };
      }
      const result = screenshotPayload();
      result.payload.displayFrameId = `display-frame-${++screenshotCalls}`;
      return result;
    });
    const contextEpoch = { value: 0 };
    const tool = createVisionComputerTool({ contextEpoch });
    const first = await tool.execute("shot-1", { action: "screenshot" });
    const frameId = readFrameId(first);
    expect(first.details).toMatchObject({
      media: { outbound: false },
      refWidth: EFFECTIVE_REF_WIDTH,
    });

    const second = await tool.execute("shot-2", { action: "screenshot" });

    expect(second.content).toEqual([
      {
        type: "text",
        text: `screen unchanged since previous frame (frameId ${frameId}); screenshot omitted — keep using this frameId for coordinates`,
      },
    ]);
    expect(second.details).toMatchObject({
      frameId,
      screenIndex: 0,
      refWidth: EFFECTIVE_REF_WIDTH,
    });
    expect(contextEpoch).toMatchObject({ frameToolCallId: "shot-1" });

    await expect(executeClick(tool, frameId)).resolves.toBeDefined();
    expect(readLastComputerActParams()).toMatchObject({ displayFrameId: "display-frame-2" });
  });

  it("delivers changed screenshot pixels under a new coordinate frame", async () => {
    const changedPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
    callGatewayToolMock
      .mockResolvedValueOnce(screenshotPayload())
      .mockResolvedValueOnce(screenshotPayload(0, changedPng));
    const tool = createVisionComputerTool({ contextEpoch: { value: 0 } });
    const firstFrameId = await captureFrame(tool, {}, "shot-1");

    const changed = await tool.execute("shot-2", { action: "screenshot" });

    expect(changed.content).toContainEqual(expect.objectContaining({ type: "image" }));
    expect(readFrameId(changed)).not.toBe(firstFrameId);
    await rejectsClick(tool, firstFrameId, /frameId does not match/);
  });

  it("preserves wait metadata when its follow-up screenshot is unchanged", async () => {
    const tool = createVisionComputerTool({ contextEpoch: { value: 0 } });
    const frameId = await captureFrame(tool, {}, "shot-1");

    const result = await tool.execute("wait", { action: "wait", duration: 0 });

    expect(result.content).toEqual([
      {
        type: "text",
        text: `waited 0s\nscreen unchanged since previous frame (frameId ${frameId}); screenshot omitted — keep using this frameId for coordinates`,
      },
    ]);
  });

  it.each([
    ["another screen", { screenIndex: 1 }],
    ["another node", { node: "mac-b" }],
  ])("does not reuse identical screenshot pixels from %s", async (_name, input) => {
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
    const tool = createVisionComputerTool({ contextEpoch: { value: 0 } });
    const firstFrameId = await captureFrame(tool, { node: "mac-a" }, "shot-1");

    const result = await tool.execute("shot-2", { action: "screenshot", ...input });

    expect(result.content).toContainEqual(expect.objectContaining({ type: "image" }));
    expect(readFrameId(result)).not.toBe(firstFrameId);
  });

  it("keeps queued calls distinct across assistant responses while preserving replay keys", async () => {
    const tool = createVisionComputerTool({ idempotencyScope: "run-1" });
    await Promise.all(
      ["response-1", "response-2", "response-1"].map((responseId) => {
        const input = { action: "type", text: responseId };
        const toolCall = {
          type: "toolCall" as const,
          id: "computer_0",
          name: "computer",
          arguments: input,
        };
        return runWithAgentToolExecutionContext(
          {
            assistantMessage: makeAssistantMessageFixture({
              responseId,
              content: [toolCall],
              stopReason: "toolUse",
            }),
            toolCall,
          },
          () => tool.execute(toolCall.id, input),
        );
      }),
    );

    const actKeys = computerActBodies().map((body) => body.idempotencyKey);
    expect(actKeys).toHaveLength(3);
    expect(actKeys[1]).not.toBe(actKeys[0]);
    expect(actKeys[2]).toBe(actKeys[0]);
  });

  it("does not share node receipts across runs that reuse a tool call id", async () => {
    for (const idempotencyScope of ["run-1", "run-2"]) {
      const tool = createVisionComputerTool({ idempotencyScope });
      await tool.execute("call-computer-1", { action: "type", text: "hello" });
    }

    const actKeys = computerActBodies().map((body) => body.idempotencyKey);
    expect(actKeys).toHaveLength(2);
    expect(actKeys[1]).not.toBe(actKeys[0]);
  });

  it("does not share node receipts when no stable run scope is available", async () => {
    const tool = createVisionComputerTool();

    await tool.execute("reused-call-id", { action: "type", text: "first" });
    await tool.execute("reused-call-id", { action: "type", text: "second" });

    const actKeys = computerActBodies().map((body) => body.idempotencyKey);
    expect(actKeys).toHaveLength(2);
    expect(actKeys[0]).not.toBe(actKeys[1]);
  });

  it("surfaces the persistent deny remediation", async () => {
    mockComputerActError(
      new Error(
        'node command not allowed: "computer.act" is blocked by gateway.nodes.commands.deny',
      ),
    );
    const { tool, frameId } = await createToolWithFrame({}, {}, "call");
    await rejectsClick(
      tool,
      frameId,
      /remove computer\.act from gateway\.nodes\.commands\.deny/,
      { coordinate: [10, 10] },
      "call",
    );
  });

  it("expires screenshot coordinates when compaction removes the image context", async () => {
    const contextEpoch = { value: 0 };
    const { tool, frameId } = await createToolWithFrame({ contextEpoch });

    contextEpoch.value += 1;

    await rejectsClick(tool, frameId, /screenshot/i, { coordinate: [5, 5] });
    expect(computerActBodies()).toHaveLength(0);
  });

  it("rejects a stale screenshot frame when windowRef is whitespace-only", async () => {
    const { tool, frameId } = await createToolWithFrame();
    const input = { windowRef: " \t " };

    await rejectsClick(
      tool,
      `${frameId}-stale`,
      "computer: frameId does not match the most recent screenshot result; take a new screenshot",
      input,
    );
    expect(computerActBodies()).toHaveLength(0);

    await expect(executeClick(tool, frameId, input)).resolves.toMatchObject({
      details: { action: "left_click" },
    });
    expect(readLastComputerActParams()).not.toHaveProperty("windowRef");
  });

  it.each([
    [
      "fails closed when a coordinate action has no observed screenshot frame",
      { action: "left_click", coordinate: [5, 5] },
      /screenshot/i,
    ],
    [
      "does not let an explicit screen index substitute for an observed frame",
      {
        action: "left_click",
        coordinate: [5, 5],
        screenIndex: 0,
        frameId: "guessed",
      },
      /screenshot/i,
    ],
    [
      "rejects an invalid screen index instead of clamping it to display zero",
      { action: "screenshot", screenIndex: -1 },
      /screenIndex must be a non-negative integer/,
    ],
  ])("%s", async (_name, input, error) => {
    await expect(createVisionComputerTool().execute("call", input)).rejects.toThrow(error);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it.each<InvalidCase>([
    invalidScrollCase("zero scroll amount", 0),
    invalidScrollCase("string scroll amount", "many"),
    ["missing scroll direction", { action: "scroll" }, /scrollDirection/],
    invalidHoldCase("oversized hold duration", 11),
  ])("rejects invalid %s before invoking the node", async (_label, params, error) => {
    await expect(createVisionComputerTool().execute("call", params)).rejects.toThrow(error);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("refuses to arm coordinates from a snapshot without physical display identity", async () => {
    callGatewayToolMock.mockResolvedValue({
      payload: { format: "png", base64: TINY_PNG_BASE64, width: 1280, height: 800, screenIndex: 0 },
    });
    await expect(
      createVisionComputerTool().execute("call", { action: "screenshot" }),
    ).rejects.toThrow(/missing displayFrameId/);
  });

  it("rejects a coordinate action that retargets a different display", async () => {
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
      (body as ComputerActBody).command === COMPUTER_ACT_COMMAND
        ? { payload: { ok: true } }
        : screenshotPayload(1),
    );
    const { tool, frameId } = await createToolWithFrame({}, { screenIndex: 1 }, "call");
    await rejectsClick(
      tool,
      frameId,
      /screenIndex does not match/,
      { coordinate: [10, 20], screenIndex: 0 },
      "call",
    );
    expect(computerActBodies()).toHaveLength(0);
  });

  it("does not inherit another node's frame when a coordinate action names a different node", async () => {
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
    const { tool, frameId } = await createToolWithFrame(
      {},
      { node: "mac-a", screenIndex: 1 },
      "call",
    );
    await rejectsClick(tool, frameId, /no screenshot of this computer/i, { node: "mac-b" }, "call");
  });

  it("does not authorize coordinates when screenshot sanitization omits the image", async () => {
    callGatewayToolMock.mockResolvedValue(screenshotPayload(0, "not-base64!!!"));
    const { tool, frameId } = await createToolWithFrame({}, {}, "call");
    await rejectsClick(tool, frameId, /no screenshot/i, {}, "call");
  });

  it("invalidates the old frame when the post-action screenshot fails", async () => {
    mockFirstScreenshotThenFailure();
    const contextEpoch = { value: 0 };
    const { tool, frameId } = await createToolWithFrame({ contextEpoch }, {}, "call");
    await expect(executeClick(tool, frameId, {}, "call")).resolves.toMatchObject({
      details: { action: "left_click" },
    });
    expect(contextEpoch).toEqual({ value: 0 });
    await rejectsClick(tool, frameId, /no screenshot/i, { coordinate: [2, 3] }, "call");
  });

  it("keeps target affinity for button release after a failed screenshot", async () => {
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
    mockFirstScreenshotThenFailure(1);
    const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a", screenIndex: 1 });
    await executeMouseDown(tool, frameId);
    await expect(retargetToMacB(tool)).rejects.toThrow(
      /left button may still be held on node mac-a/,
    );
    await tool.execute("up", { action: "left_mouse_up" });

    const actBodies = computerActBodies();
    expect(actBodies).toMatchObject([
      { nodeId: "mac-a", params: { action: "left_mouse_down", screenIndex: 1 } },
      { nodeId: "mac-a", params: { action: "left_mouse_up", screenIndex: 1 } },
    ]);
    expect(actBodies[1]?.params).not.toHaveProperty("displayFrameId");
  });

  it("clears button affinity when the gateway definitively rejects mouse down", async () => {
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
    mockComputerActError(
      Object.assign(new Error("node command rejected before dispatch"), {
        name: "GatewayClientRequestError",
        details: { reason: "command not allowlisted", command: "computer.act" },
      }),
    );
    const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a" });
    await expect(executeMouseDown(tool, frameId)).rejects.toThrow(
      /enable Computer Control.*approve the pairing update/i,
    );
    await expect(retargetToMacB(tool)).resolves.toMatchObject({ details: { node: "mac-b" } });
  });

  it("keeps button affinity after an ambiguous node timeout request error", async () => {
    const message = "TIMEOUT: node invoke timed out";
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
    mockComputerActError(
      Object.assign(new Error(message), {
        name: "GatewayClientRequestError",
        gatewayCode: "UNAVAILABLE",
        details: undefined,
      }),
      "left_mouse_down",
    );
    const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a" });

    await expect(executeMouseDown(tool, frameId)).rejects.toThrow(message);
    await expect(retargetToMacB(tool)).rejects.toThrow(
      /left button may still be held on node mac-a/,
    );

    await expect(tool.execute("up", { action: "left_mouse_up" })).resolves.toBeDefined();
    await expect(retargetToMacB(tool, "retarget-after-release")).resolves.toMatchObject({
      details: { node: "mac-b" },
    });
  });

  it("does not claim button affinity when cancellation wins during target resolution", async () => {
    const controller = new AbortController();
    let listCalls = 0;
    listNodesMock.mockImplementation(async () => {
      listCalls += 1;
      if (listCalls === 2) {
        controller.abort(new Error("cancelled before dispatch"));
      }
      return twoMacComputerNodes();
    });
    const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a" });

    await expect(
      executeMouseDown(tool, frameId, { node: "mac-a" }, controller.signal),
    ).rejects.toThrow("cancelled before dispatch");
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
    await expect(retargetToMacB(tool)).resolves.toMatchObject({ details: { node: "mac-b" } });
  });

  it("treats mouse up as idempotent after lifecycle cleanup released the button", async () => {
    listNodesMock.mockResolvedValue(twoMacComputerNodes());
    let actCalls = 0;
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        actCalls += 1;
        if (actCalls === 2) {
          throw Object.assign(
            new Error("INVALID_REQUEST: left button is not held by computer control"),
            { name: "GatewayClientRequestError" },
          );
        }
        return { payload: { ok: true } };
      }
      return screenshotPayload();
    });
    const { tool, frameId } = await createToolWithFrame({}, { node: "mac-a" });
    await executeMouseDown(tool, frameId);

    await expect(tool.execute("up", { action: "left_mouse_up" })).resolves.toBeDefined();
    await expect(retargetToMacB(tool)).resolves.toMatchObject({ details: { node: "mac-b" } });
  });

  it("aborts a wait without taking the delayed screenshot", async () => {
    const controller = new AbortController();
    const tool = createVisionComputerTool();
    const pending = tool.execute("call", { action: "wait", duration: 100 }, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(/Aborted/);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("propagates cancellation from the follow-up screenshot after input lands", async () => {
    let screenshotCalls = 0;
    let followupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      followupStarted = resolve;
    });
    callGatewayToolMock.mockImplementation(async (_method, _opts, body, extra) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        return { payload: { ok: true } };
      }
      screenshotCalls += 1;
      if (screenshotCalls === 1) {
        return screenshotPayload();
      }
      followupStarted();
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      return await new Promise<never>((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const { tool, frameId } = await createToolWithFrame();
    const pending = executeClick(tool, frameId, {}, "click", controller.signal);
    await started;
    controller.abort(new Error("cancelled during follow-up"));

    await expect(pending).rejects.toThrow(/cancelled during follow-up/);
  });

  it("does not run a dangerous action that was aborted while queued", async () => {
    let releaseScreenshot!: () => void;
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      if ((body as { command?: string }).command === COMPUTER_ACT_COMMAND) {
        return { payload: { ok: true } };
      }
      await new Promise<void>((resolve) => {
        releaseScreenshot = resolve;
      });
      return screenshotPayload();
    });
    const tool = createVisionComputerTool();
    const first = tool.execute("first", { action: "screenshot" });
    await vi.waitFor(() => expect(releaseScreenshot).toBeTypeOf("function"));
    const controller = new AbortController();
    const queued = tool.execute("queued", { action: "type", text: "never" }, controller.signal);
    controller.abort(new Error("cancelled"));
    releaseScreenshot();
    await first;
    await expect(queued).rejects.toThrow(/cancelled/);
    expect(computerActBodies()).toHaveLength(0);
  });
});
