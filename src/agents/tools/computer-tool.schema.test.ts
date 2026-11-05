import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it } from "vitest";
import { getImageMetadata } from "../../media/image-ops.js";
import { createSolidPngBuffer } from "../../plugin-sdk/test-helpers/image-fixtures.js";
import type { ComputerUseV2ActionName } from "../../plugins/computer-use-contract.js";
import type { AgentMessage, AgentToolResult } from "../runtime/index.js";
import { readToolExecutionRefusal } from "../tool-effect-receipt.js";
import {
  callGatewayToolMock,
  COMPUTER_ACT_COMMAND,
  type ComputerActBody,
  createComputerTool,
  createVisionComputerTool,
  EFFECTIVE_REF_WIDTH,
  gatewayComputerStatusMock,
  invalidateComputerFrameIfMissing,
  listNodesMock,
  loadPairedComputerUseAvailabilityForSurface,
  macComputerNode,
  readActionEnum,
  readFrameId,
  readLastComputerActParams,
  resetComputerToolMocks,
  screenshotPayload,
  sleepMock,
  TINY_PNG_BASE64,
  v2Descriptor,
} from "./computer-tool.test-helpers.js";

beforeEach(resetComputerToolMocks);

function useActions(
  actions: ComputerUseV2ActionName[],
  overrides?: Parameters<typeof v2Descriptor>[1],
) {
  listNodesMock.mockResolvedValue([
    macComputerNode({ computerUse: v2Descriptor(actions, overrides) }),
  ]);
}

function mockComputerAct(observe: (params: Record<string, unknown> | undefined) => unknown) {
  callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
    const request = body as ComputerActBody;
    return request.command === COMPUTER_ACT_COMMAND ? observe(request.params) : screenshotPayload();
  });
}

async function expectForwarded(
  tool: ReturnType<typeof createComputerTool>,
  id: string,
  params: Record<string, string | number | boolean>,
) {
  const expected = { ...params };
  await tool.execute(id, params);
  expect(readLastComputerActParams()).toEqual(expected);
}

function definition(tool: ReturnType<typeof createComputerTool>): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
}

function readCapabilities(result: AgentToolResult<unknown>): unknown {
  const prefix = "Current computer capabilities: ";
  const notice = result.content.find(
    (part) => part.type === "text" && part.text.startsWith(prefix),
  );
  if (!notice || notice.type !== "text") {
    throw new Error("Missing current computer capabilities");
  }
  return JSON.parse(notice.text.slice(prefix.length));
}

function expectUnavailable(
  result: AgentToolResult<unknown>,
  action: string,
  availableActions: readonly string[],
) {
  const refusal = { status: "refused", reason: "action_unavailable", action, availableActions };
  expect(readToolExecutionRefusal(result)?.kind).toBe("gated");
  expect(result.details).toEqual(refusal);
  expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(refusal, null, 2) });
}

// Frozen from v2026.9.4 src/plugins/computer-use-contract.ts, including actionObject fields.
// Keep independent of the current schema so mixed-version regressions remain visible.
const releasedWindowStateSchema = Type.Object(
  {
    action: Type.Enum(["get_window_state"], { type: "string" }),
    executionId: Type.Optional(
      Type.String({
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      }),
    ),
    windowRef: Type.String({ minLength: 1 }),
    query: Type.Optional(Type.String()),
    depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })),
    maxElements: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
  },
  { additionalProperties: false },
);

describe("createComputerTool v2 execution", () => {
  it.each(["screenshot", "wait"] as const)(
    "rejects a targeted %s before desktop capture",
    async (action) => {
      useActions(["screenshot", "get_window_state", "get_browser_state"]);
      const tool = createVisionComputerTool();
      for (const reference of [
        "windowRef",
        "browserRef",
        "pageRef",
        "elementRef",
        "observationId",
      ]) {
        await expect(
          tool.execute(reference, { action, [reference]: "target-1", duration: 0 }),
        ).rejects.toThrow(/COMPUTER_INVALID_REQUEST:.*get_window_state/);
      }
      expect(callGatewayToolMock).not.toHaveBeenCalled();
      expect(sleepMock).not.toHaveBeenCalled();
    },
  );

  it("derives local wait from the selected node screenshot capability", async () => {
    const actions: ComputerUseV2ActionName[] = ["screenshot", "list_apps", "get_window_state"];
    useActions(actions, {
      targets: ["screen"],
      deliveryModes: ["foreground"],
      observations: ["image"],
    });
    const tool = createVisionComputerTool();
    const prefix = definition(tool);
    const result = await tool.execute("select", { action: "wait", duration: 0 });

    expect(definition(tool)).toBe(prefix);
    expect(readCapabilities(result)).toEqual({
      actions: [...actions, "wait"],
      targets: ["screen"],
      deliveryModes: ["foreground"],
      observations: ["image"],
    });
    expect(sleepMock).toHaveBeenCalledWith(0, undefined);
    expect(
      callGatewayToolMock.mock.calls.map((call) => (call[2] as ComputerActBody).command),
    ).toEqual(["screen.snapshot"]);
    const next = await tool.execute("next", { action: "screenshot" });
    expect(definition(tool)).toBe(prefix);
    expect(
      next.content.some(
        (part) => part.type === "text" && part.text.startsWith("Current computer capabilities: "),
      ),
    ).toBe(false);
  });

  it("keeps its definition and refuses removed capabilities after explicit node refresh", async () => {
    const initial = v2Descriptor(["screenshot", "list_windows"]);
    const upgraded = v2Descriptor(["screenshot", "launch_app"], {
      provider: { ...initial.provider, generation: "generation-2" },
    });
    const gatewayOptions = { gatewayUrl: "wss://gateway.example", gatewayToken: "fixture-token" };
    listNodesMock
      .mockResolvedValueOnce([macComputerNode({ computerUse: initial })])
      .mockResolvedValue([macComputerNode({ computerUse: upgraded })]);
    const tool = createVisionComputerTool({
      pairedNodeComputerUse: { actions: initial.actions, guidanceCapabilities: initial },
    });
    const prefix = definition(tool);
    expect(readActionEnum(tool)).toEqual(
      expect.arrayContaining(["screenshot", "left_click", "list_windows", "wait"]),
    );
    expect(readActionEnum(tool)).not.toContain("launch_app");
    const phases = [
      { unavailable: "launch_app", actions: ["screenshot", "list_windows", "wait"] },
      { unavailable: "list_windows", actions: ["screenshot", "launch_app", "wait"] },
    ];
    for (const [index, phase] of phases.entries()) {
      const observation = await tool.execute(`observe-${index}`, {
        action: "screenshot",
        node: "mac-1",
        ...(index === 0 ? gatewayOptions : {}),
      });
      expect(definition(tool)).toBe(prefix);
      expect(readCapabilities(observation)).toMatchObject({ actions: phase.actions });
      expect(readActionEnum(tool)).toContain("list_windows");
      expectUnavailable(
        await tool.execute(`unavailable-${index}`, {
          action: phase.unavailable,
          ...(phase.unavailable === "launch_app" ? { app: "Fixture" } : {}),
        }),
        phase.unavailable,
        phase.actions,
      );
      expect(definition(tool)).toBe(prefix);
      expect(callGatewayToolMock).toHaveBeenCalledTimes(index + 1);
    }
    expect(listNodesMock).toHaveBeenLastCalledWith(
      expect.objectContaining(gatewayOptions),
      undefined,
    );
    await tool.execute("new-action", { action: "launch_app", app: "Fixture" });
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      expect.objectContaining(gatewayOptions),
      expect.objectContaining({
        nodeId: "mac-1",
        command: "computer.act",
        params: expect.objectContaining({ action: "launch_app", app: "Fixture" }),
      }),
      { signal: undefined },
    );
    await expect(
      tool.execute("retarget", {
        action: "screenshot",
        node: "mac-1",
        gatewayUrl: "wss://other-gateway.example",
      }),
    ).rejects.toThrow("bound to its Gateway connection");
  });

  it("reports Gateway override capabilities without rewriting the prepared definition", async () => {
    const remoteCapabilities = v2Descriptor(["screenshot", "launch_app", "get_accessibility_tree"]);
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: remoteCapabilities })]);
    const tool = createVisionComputerTool({
      pairedNodeComputerUse: {
        actions: ["screenshot", "list_windows", "get_window_state"],
        guidanceCapabilities: v2Descriptor(["screenshot", "list_windows", "get_window_state"]),
      },
    });

    const prefix = definition(tool);
    const gatewayOptions = { gatewayUrl: "wss://gateway.example", gatewayToken: "remote-token" };
    const result = await tool.execute("remote-observe", {
      action: "screenshot",
      ...gatewayOptions,
    });
    expect(definition(tool)).toBe(prefix);
    expect(readCapabilities(result)).toMatchObject({
      actions: ["screenshot", "launch_app", "get_accessibility_tree", "wait"],
    });

    expect(listNodesMock).toHaveBeenCalledWith(expect.objectContaining(gatewayOptions), undefined);
    await expectForwarded(tool, "legacy-tree", {
      action: "get_accessibility_tree",
      query: "Save",
      depth: 10,
      maxElements: 100,
    });
  });

  it.each([false, true])(
    "requires a cleanup owner for execution-owned actions (owner=%s)",
    async (hasCleanup) => {
      const actions: ComputerUseV2ActionName[] = [
        "screenshot",
        "browser_download",
        "start_recording",
      ];
      useActions(actions);
      const tool = createVisionComputerTool({
        pairedNodeComputerUse: { actions, guidanceCapabilities: v2Descriptor(actions) },
        ...(hasCleanup ? { registerRunCleanup: () => {} } : {}),
      });
      const result = await tool.execute("bind", { action: "screenshot" });
      expect(readCapabilities(result)).toMatchObject({
        actions: hasCleanup ? [...actions, "wait"] : ["screenshot", "wait"],
      });
      if (hasCleanup) {
        expect(readActionEnum(tool)).toEqual(expect.arrayContaining(actions));
      } else {
        expect(readActionEnum(tool)).not.toContain("browser_download");
        expect(readActionEnum(tool)).not.toContain("start_recording");
        expectUnavailable(
          await tool.execute("record", { action: "start_recording" }),
          "start_recording",
          ["screenshot", "wait"],
        );
        expect(callGatewayToolMock).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    [["list_apps"], 0],
    [["screenshot"], 1],
  ] as const)("keeps local wait authority for %s", async (actions, captures) => {
    useActions([...actions]);
    callGatewayToolMock.mockRejectedValue(new Error("snapshot policy denied"));
    const tool = createVisionComputerTool();

    const result = tool.execute("wait", { action: "wait", duration: 0 });
    if (captures === 0) {
      expectUnavailable(await result, "wait", actions);
    } else {
      await expect(result).rejects.toThrow("snapshot policy denied");
    }

    expect(callGatewayToolMock).toHaveBeenCalledTimes(captures);
    expect(
      callGatewayToolMock.mock.calls.every(
        (call) => (call[2] as ComputerActBody).command === "screen.snapshot",
      ),
    ).toBe(true);
  });

  it.each([
    ["portrait pixels", 784, 1568, "image-pixels", 392, 784],
    ["rounded axes", 1567, 785, "image-pixels", 783.5, 391.846922],
    ["global logical points", 1568, 784, "global-logical-points", 600, 300],
  ] as const)(
    "binds delivered window image coordinates: %s",
    async (_name, width, height, coordinateSpace, expectedX, expectedY) => {
      useActions(["get_window_state", "left_click", "left_click_drag", "zoom"]);
      const bounds = { x: 1920, y: 300, width: 400, height: 200 };
      const observation = {
        kind: "window",
        base64: createSolidPngBuffer(width, height, { r: 70, g: 125, b: 180 }).toString("base64"),
        format: "png",
        width,
        height,
        observationId: "observation-1",
        elements: [{ elementRef: "element-1", role: "button", label: "Save", bounds }],
      };
      mockComputerAct((params) =>
        params?.action === "get_window_state"
          ? { payload: { ok: true, observation, details: { coordinateSpace } } }
          : { payload: { ok: true } },
      );
      const tool = createVisionComputerTool();
      const refs = { windowRef: "window-1", observationId: "observation-1" };
      const result = await tool.execute("observe", {
        action: "get_window_state",
        windowRef: refs.windowRef,
      });
      const image = result.content.find((block) => block.type === "image");
      if (!image) {
        throw new Error("Missing delivered observation image");
      }
      const dimensions = await getImageMetadata(Buffer.from(image.data, "base64"));
      if (!dimensions) {
        throw new Error("Missing delivered image dimensions");
      }
      expect(result.details).toMatchObject({
        result: { observation: { ...dimensions, elements: [{ bounds }] } },
      });
      expect(callGatewayToolMock).toHaveBeenCalledOnce();
      expect(sleepMock).not.toHaveBeenCalledWith(500, expect.anything());
      const coordinate = [Math.floor(dimensions.width / 2), Math.floor(dimensions.height / 2)];
      const startCoordinate = coordinate.map((value) => value / 2);
      for (const action of ["left_click", "left_click_drag", "zoom"] as const) {
        await tool.execute(action, {
          action,
          ...refs,
          ...(action === "zoom"
            ? {
                x1: startCoordinate[0],
                y1: startCoordinate[1],
                x2: coordinate[0],
                y2: coordinate[1],
              }
            : { coordinate, ...(action === "left_click_drag" ? { startCoordinate } : {}) }),
        });
        const sent = readLastComputerActParams(action);
        expect(sent[action === "zoom" ? "x2" : "x"]).toBeCloseTo(expectedX, 6);
        expect(sent[action === "zoom" ? "y2" : "y"]).toBeCloseTo(expectedY, 6);
        if (action !== "left_click") {
          expect(sent[action === "zoom" ? "x1" : "fromX"]).toBeCloseTo(expectedX / 2, 6);
          expect(sent[action === "zoom" ? "y1" : "fromY"]).toBeCloseTo(expectedY / 2, 6);
        }
      }
    },
  );

  it.each([undefined, true])(
    "preserves capture on a released node with includeScreenshot=%s",
    async (includeScreenshot) => {
      useActions(["get_window_state"]);
      mockComputerAct((params) => {
        if (!Value.Check(releasedWindowStateSchema, params)) {
          throw new Error("Released node rejected get_window_state params");
        }
        return {
          payload: {
            ok: true,
            observation: {
              kind: "window",
              base64: createSolidPngBuffer(2, 1, { r: 70, g: 125, b: 180 }).toString("base64"),
              format: "png",
              width: 2,
              height: 1,
              observationId: "released-observation",
            },
            details: { coordinateSpace: "image-pixels" },
          },
        };
      });
      const tool = createVisionComputerTool();
      const result = await tool.execute("observe", {
        action: "get_window_state",
        windowRef: "window-1",
        includeScreenshot,
      });
      expect(result.content.some((block) => block.type === "image")).toBe(true);
      expect(readLastComputerActParams()).toMatchObject({ action: "get_window_state" });
      expect(callGatewayToolMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects a non-boolean window screenshot option", async () => {
    useActions(["get_window_state"]);
    const tool = createVisionComputerTool();
    await expect(
      tool.execute("observe", {
        action: "get_window_state",
        windowRef: "window-1",
        includeScreenshot: "true",
      }),
    ).rejects.toThrow("includeScreenshot must be a boolean");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it.each(["invalid", "omitted"] as const)(
    "rejects pixel input for an %s observation image but keeps element refs",
    async (image) => {
      useActions(["get_window_state", "left_click"]);
      callGatewayToolMock.mockResolvedValue({
        payload: {
          ok: true,
          observation: {
            kind: "window",
            ...(image === "invalid" ? { base64: "invalid!" } : {}),
            width: 1568,
            height: 784,
            observationId: "observation-1",
          },
          details: { coordinateSpace: "image-pixels" },
        },
      });
      const tool = createVisionComputerTool();
      const refs = { windowRef: "window-1", observationId: "observation-1" };
      const result = await tool.execute("observe", {
        action: "get_window_state",
        windowRef: refs.windowRef,
        ...(image === "omitted" ? { includeScreenshot: false } : {}),
      });
      if (image === "omitted") {
        expect(readLastComputerActParams()).toMatchObject({ includeScreenshot: false });
      }
      expect(result.content.some((block) => block.type === "image")).toBe(false);
      callGatewayToolMock.mockClear();
      await expect(
        tool.execute("pixels", { action: "left_click", ...refs, coordinate: [600, 300] }),
      ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
      expect(callGatewayToolMock).not.toHaveBeenCalled();
      await tool.execute("element", { action: "left_click", ...refs, elementRef: "element-1" });
      expect(readLastComputerActParams("left_click")).toMatchObject({
        action: "left_click",
        elementRef: "element-1",
      });
    },
  );

  it.each(["inspect", "accept"])(
    "captures an after-image only for a dialog mutation: %s",
    async (dialogAction) => {
      useActions(["browser_dialog"]);
      callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
        (body as ComputerActBody).command === COMPUTER_ACT_COMMAND
          ? { payload: { ok: true, effect: "confirmed" } }
          : screenshotPayload(),
      );
      await createVisionComputerTool().execute("dialog", {
        action: "browser_dialog",
        browserRef: "browser-1",
        pageRef: "page-1",
        dialogAction,
        ...(dialogAction === "inspect" ? {} : { dialogRef: "dialog-1" }),
      });
      expect(
        callGatewayToolMock.mock.calls.map((call) => (call[2] as ComputerActBody).command),
      ).toEqual(
        dialogAction === "inspect"
          ? [COMPUTER_ACT_COMMAND]
          : [COMPUTER_ACT_COMMAND, "screen.snapshot"],
      );
    },
  );

  it("maps browser observations and opaque refs through the public tool", async () => {
    useActions(["get_browser_state", "browser_pointer", "browser_type"]);
    mockComputerAct((params) => ({
      payload:
        params?.action === "get_browser_state"
          ? { ok: true, observation: { kind: "browser", observationId: "browser-observation-1" } }
          : { ok: true, effect: "confirmed" },
    }));
    const tool = createVisionComputerTool({
      pairedNodeComputerUse: { actions: ["get_browser_state", "browser_pointer", "browser_type"] },
    });
    const refs = { browserRef: "browser-1", pageRef: "page-1" };
    await expectForwarded(tool, "observe-browser", {
      action: "get_browser_state",
      ...refs,
      snapshotFormat: "dom_refs_v1",
      includeScreenshot: true,
    });
    expect(tool.parameters).toHaveProperty(
      "properties.query.description",
      expect.stringContaining("get_browser_state: requires snapshotFormat=semantic_v2"),
    );

    for (const text of ["  hello\t\n", " \t\n", ""]) {
      await tool.execute("observe", { action: "get_browser_state", ...refs });
      await expectForwarded(tool, "type-browser", {
        action: "browser_type",
        ...refs,
        observationId: "browser-observation-1",
        elementRef: "element-1",
        text,
      });
    }
    await expectForwarded(tool, "drag-browser", {
      action: "browser_pointer",
      ...refs,
      observationId: "browser-observation-1",
      pointerAction: "drag",
      inputRoute: "dom_event",
      elementRef: "element-1",
      destinationElementRef: "element-2",
    });
  });

  it("routes current element refs without coordinates and rejects stale semantic refs before dispatch", async () => {
    useActions(["get_window_state", "left_click", "set_value"]);
    mockComputerAct((params) => ({
      payload:
        params?.action === "get_window_state"
          ? { ok: true, observation: { kind: "window", observationId: "observation-1" } }
          : { ok: true, effect: "confirmed" },
    }));
    const tool = createVisionComputerTool();
    const refs = {
      windowRef: "window-1",
      elementRef: "element-1",
      observationId: "observation-1",
      deliveryMode: "background",
    };
    await tool.execute("observe", { action: "get_window_state", windowRef: refs.windowRef });
    await expect(tool.execute("click", { action: "left_click", ...refs })).resolves.toBeDefined();
    expect(readLastComputerActParams("left_click")).toEqual({
      action: "left_click",
      screenIndex: 0,
      refWidth: EFFECTIVE_REF_WIDTH,
      ...refs,
    });
    for (const value of ["  hello\t\n", " \t\n", ""]) {
      await tool.execute("observe", { action: "get_window_state", windowRef: refs.windowRef });
      await tool.execute("write", { action: "set_value", ...refs, value });
      expect(readLastComputerActParams("set_value")).toMatchObject({ ...refs, value });
    }
    callGatewayToolMock.mockClear();
    await expect(
      tool.execute("write", {
        action: "set_value",
        ...refs,
        observationId: "observation-stale",
        value: "hello",
      }),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("maps recording resources and closes their exact host execution through attempt-owned cleanup", async () => {
    useActions(["get_recording_state", "start_recording", "stop_recording", "replay_trajectory"]);
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createVisionComputerTool({
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });

    await expectForwarded(tool, "record", { action: "start_recording", recordVideo: true });
    const start = callGatewayToolMock.mock.calls
      .map((call) => call[2] as ComputerActBody)
      .findLast((body) => body.command === COMPUTER_ACT_COMMAND);
    if (!start?.params) {
      throw new Error("missing start_recording node invocation");
    }
    const executionId = start.params.executionId;
    expect(executionId).toEqual(expect.any(String));
    await expectForwarded(tool, "replay", {
      action: "replay_trajectory",
      resourceHandle: "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000",
      delayMs: 25,
      stopOnError: false,
    });
    await cleanup?.("completion");

    const close = callGatewayToolMock.mock.calls.at(-1)?.[2] as ComputerActBody;
    expect(close.params).toEqual({
      action: "__close_execution",
      executionId,
      reason: "completion",
    });
  });
});

describe("createComputerTool schema", () => {
  it("publishes capability-specific session schemas without mutating prior definitions", async () => {
    const capabilities = v2Descriptor(["screenshot", "key", "wait"]);
    const transport = {
      computerUse: capabilities,
      resolveNode: async () => ({ nodeId: "session-desktop" }),
      invoke: async () => undefined,
    };
    const first = createComputerTool({ transport });
    const prefix = definition(first);
    const next = createComputerTool({
      transport: {
        ...transport,
        computerUse: {
          ...capabilities,
          provider: { ...capabilities.provider, generation: "generation-2" },
        },
      },
    });
    expect(next.parameters).toBe(first.parameters);
    expect(Reflect.set(readActionEnum(first), "0", "launch_app")).toBe(false);
    capabilities.actions.push("launch_app");
    const changed = createComputerTool({ transport });
    expect(changed.parameters).not.toBe(first.parameters);
    expect(readActionEnum(first)).toEqual(["screenshot", "key", "wait", "take_control"]);
    expect(readActionEnum(changed)).toContain("launch_app");
    expect(first.parameters).not.toHaveProperty("properties.target");
    expect(createComputerTool().parameters).toHaveProperty("properties.target");
    expect(JSON.stringify(first.parameters)).not.toContain("hold_key");
    expect(first.description).toContain("key taps only");
    expectUnavailable(
      await first.execute("hold", { action: "hold_key", text: "a", duration: 1 }),
      "hold_key",
      ["screenshot", "key", "wait", "launch_app"],
    );
    expect(definition(first)).toBe(prefix);
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it.each<[string, ...Required<Parameters<typeof v2Descriptor>>, RegExp, RegExp]>([
    [
      "desktop",
      ["screenshot", "left_click"],
      { targets: ["screen"], deliveryModes: ["foreground"], observations: ["image"] },
      /desktop coordinates/,
      /get_window_state|accessibility|elementRef|background_unavailable/,
    ],
    [
      "background windows",
      ["left_click", "list_windows", "get_window_state", "set_value"],
      { targets: ["window", "element"], deliveryModes: ["background"] },
      /deliveryMode:"background"/,
      /desktop coordinates|foreground|frameId/,
    ],
    [
      "accessibility discovery",
      ["get_accessibility_tree"],
      {},
      /Control/,
      /get_window_state|list_windows|unfiltered/,
    ],
    [
      "image windows",
      ["list_windows", "get_accessibility_tree", "get_window_state"],
      { observations: ["image"] },
      /advertised image data/,
      /window subtree|`query`|`depth`|`maxElements`/,
    ],
    ["held keys", ["screenshot", "key", "hold_key"], {}, /`hold_key`/, /key taps only/],
  ])(
    "keeps capability-specific guidance for %s",
    (_name, actions, overrides, included, excluded) => {
      const computerUse = v2Descriptor([...actions], overrides);
      const tool = createComputerTool({
        transport: {
          computerUse,
          resolveNode: async () => ({ nodeId: "session-desktop" }),
          invoke: async () => undefined,
        },
      });
      expect(tool.description).toMatch(included);
      expect(tool.description).not.toMatch(excluded);
      if (!actions.some((action) => action === "screenshot")) {
        expect(readActionEnum(tool)).toEqual(actions);
      }
    },
  );

  it("keeps the definition stable when automatic selection uses a paired node", async () => {
    gatewayComputerStatusMock.mockResolvedValue({ configured: false, available: false });
    useActions(["screenshot", "left_click"]);
    const availability = await loadPairedComputerUseAvailabilityForSurface({
      computerAllowed: true,
    });
    const tool = createComputerTool({ pairedNodeComputerUse: availability?.prepared });

    expect(tool.parameters).toHaveProperty("properties.target.enum", ["node"]);
    expect(tool.description).toContain("The Gateway has no computer provider configured");
    expect(tool.description).toContain("omit target or use target: node");
    expect(tool.description).not.toContain("the Gateway desktop");
    const prefix = definition(tool);

    // Omitting the selector still resolves the sole paired desktop end to end.
    const screenshot = await tool.execute("paired", { action: "screenshot" });
    expect(screenshot.details).toMatchObject({ node: "mac-1" });
    expect(definition(tool)).toBe(prefix);
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({ nodeId: "mac-1", command: "screen.snapshot" }),
      { signal: undefined },
    );
  });

  it("loads paired capabilities only for an exposed ordinary paired surface", async () => {
    const transport = {
      resolveNode: async () => ({ nodeId: "session-desktop" }),
      invoke: async () => undefined,
    };

    listNodesMock.mockResolvedValue([]);
    await expect(
      loadPairedComputerUseAvailabilityForSurface({
        computerAllowed: true,
        modelHasVision: true,
      }),
    ).resolves.toBeDefined();
    expect(listNodesMock).toHaveBeenCalledTimes(1);

    for (const params of [
      { computerAllowed: false, modelHasVision: true },
      { computerAllowed: true, modelHasVision: false },
      { computerAllowed: true, modelHasVision: true, embeddedMode: true },
      { computerAllowed: true, modelHasVision: true, computerTransport: transport },
      { computerAllowed: true, modelHasVision: true, computerTransport: null },
    ]) {
      expect(await loadPairedComputerUseAvailabilityForSurface(params)).toBeUndefined();
    }
    expect(listNodesMock).toHaveBeenCalledTimes(1);
  });

  it("publishes portable provider-neutral input and browser reference prerequisites", () => {
    const capabilities = v2Descriptor([
      "screenshot",
      "left_click",
      "list_windows",
      "get_accessibility_tree",
      "get_window_state",
      "set_value",
    ]);
    const tool = createComputerTool({
      pairedNodeComputerUse: { actions: capabilities.actions, guidanceCapabilities: capabilities },
    });
    const description = tool.description;
    expect(description).toContain("list_windows");
    expect(description).toContain("get_window_state");
    expect(description).toContain("observationId");
    expect(description).toContain("`query`");
    expect(description).not.toMatch(
      /cua|peekaboo|\b(?:cli|mcp|daemon|socket|install(?:ation|ing)?)\b|verify_state|start_session|end_session|element_token|snapshot_id|window_id|delivery_mode/iu,
    );
    expect(description.length).toBeLessThan(2_400);
    const schema = JSON.stringify(tool.parameters);
    expect(schema).not.toMatch(
      /"(?:providerTool|arguments|binaryPath|socketPath|session|driverArgs|output_dir|destinationRoot)":/,
    );
    for (const [field, prerequisites] of [
      ["windowRef", ["list_windows", "browser_prepare", "required", "get_browser_state"]],
      ["browserRef", ["get_browser_state", "windowRef", "requires pageRef"]],
      ["pageRef", ["get_browser_state", "windowRef", "requires browserRef"]],
    ] as const) {
      for (const prerequisite of prerequisites) {
        expect(tool.parameters).toHaveProperty(
          `properties.${field}.description`,
          expect.stringContaining(prerequisite),
        );
      }
    }
    for (const key of ["coordinate", "startCoordinate"] as const) {
      expect(tool.parameters).toHaveProperty(
        `properties.${key}`,
        expect.objectContaining({
          type: "array",
          items: expect.objectContaining({ type: "integer", minimum: 0 }),
          minItems: 2,
          maxItems: 2,
        }),
      );
      expect(tool.parameters).not.toHaveProperty(`properties.${key}.additionalItems`);
    }
  });
});

function imageIdentity(data: string, mimeType = "image/png") {
  return createHash("sha256")
    .update(JSON.stringify([mimeType, data]))
    .digest("hex");
}

function computerToolResult(
  toolCallId: string,
  content: Extract<AgentMessage, { role: "toolResult" }>["content"],
) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName: "computer",
    content,
    details: {},
    isError: false,
    timestamp: 1,
  } satisfies AgentMessage;
}

function trackedContextEpoch(value: number) {
  return {
    value,
    frameToolCallId: "shot-1",
    frameImageIdentity: imageIdentity(TINY_PNG_BASE64),
  };
}

function screenshotToolResult(data = TINY_PNG_BASE64) {
  return computerToolResult("shot-1", [{ type: "image", data, mimeType: "image/png" }]);
}

describe("computer screenshot context binding", () => {
  it("tracks the original image across deduplication and redelivers after context pruning", async () => {
    const contextEpoch = { value: 0 };
    const tool = createVisionComputerTool({ contextEpoch });
    const original = await tool.execute("shot-1", { action: "screenshot" });
    const frameId = readFrameId(original);
    const duplicate = await tool.execute("shot-2", { action: "screenshot" });
    const duplicateMessage = computerToolResult("shot-2", duplicate.content);

    expect(duplicate.content.every((block) => block.type !== "image")).toBe(true);
    expect(readFrameId(duplicate)).toBe(frameId);
    expect(
      invalidateComputerFrameIfMissing({
        contextEpoch,
        messages: [computerToolResult("shot-1", original.content), duplicateMessage],
      }),
    ).toBe(false);
    expect(contextEpoch).toMatchObject({ value: 0, frameToolCallId: "shot-1" });

    expect(
      invalidateComputerFrameIfMissing({
        contextEpoch,
        messages: [
          computerToolResult("shot-1", [{ type: "text", text: "image pruned" }]),
          duplicateMessage,
        ],
      }),
    ).toBe(true);
    expect(contextEpoch).toEqual({ value: 1 });

    const redelivered = await tool.execute("shot-3", { action: "screenshot" });

    expect(redelivered.content).toContainEqual(expect.objectContaining({ type: "image" }));
    expect(readFrameId(redelivered)).not.toBe(frameId);
    expect(contextEpoch).toMatchObject({ value: 1, frameToolCallId: "shot-3" });
  });

  it.each([
    ["missing", [computerToolResult("shot-1", [{ type: "text", text: "compacted" }])], false],
    ["blocked", [screenshotToolResult()], true],
    ["replaced", [screenshotToolResult("AQ==")], false],
    ["orphaned", [], false],
  ] as const)(
    "expires %s screenshot references exactly once",
    (reason, messages, imagesBlocked) => {
      const contextEpoch =
        reason === "orphaned"
          ? { value: 8, frameImageIdentity: imageIdentity(TINY_PNG_BASE64) }
          : trackedContextEpoch(8);
      expect(
        invalidateComputerFrameIfMissing({ contextEpoch, messages: [...messages], imagesBlocked }),
      ).toBe(true);
      expect(contextEpoch).toEqual({ value: 9 });
      expect(invalidateComputerFrameIfMissing({ contextEpoch, messages: [] })).toBe(false);
      expect(contextEpoch).toEqual({ value: 9 });
    },
  );
});
