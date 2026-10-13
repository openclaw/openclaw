import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it } from "vitest";
import { getImageMetadata } from "../../media/image-ops.js";
import { createSolidPngBuffer } from "../../plugin-sdk/test-helpers/image-fixtures.js";
import type { ComputerUseV2ActionName } from "../../plugins/computer-use-contract.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  callGatewayToolMock,
  COMPUTER_ACT_COMMAND,
  type ComputerActBody,
  createComputerTool,
  createVisionComputerTool,
  EFFECTIVE_REF_WIDTH,
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
      listNodesMock.mockResolvedValue([
        macComputerNode({
          computerUse: v2Descriptor(["screenshot", "get_window_state", "get_browser_state"]),
        }),
      ]);
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
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    const tool = createVisionComputerTool();
    expect(tool.description).not.toContain("get_window_state");

    await tool.execute("select", { action: "wait", duration: 0 });

    expect(readActionEnum(tool)).toEqual([...actions, "wait", "take_control"]);
    expect(sleepMock).toHaveBeenCalledWith(0, undefined);
    expect(
      callGatewayToolMock.mock.calls.map((call) => (call[2] as ComputerActBody).command),
    ).toEqual(["screen.snapshot"]);
    expect(tool.description).toContain("Observe first with `get_window_state`");
  });

  it("adopts refreshed node capabilities on explicit re-selection without changing Gateways", async () => {
    const initial = v2Descriptor(["screenshot", "list_windows"]);
    const upgraded = v2Descriptor(["screenshot", "launch_app"], {
      provider: { ...initial.provider, generation: "generation-2" },
    });
    const gatewayOptions = { gatewayUrl: "wss://gateway.example", gatewayToken: "fixture-token" };
    listNodesMock
      .mockResolvedValueOnce([macComputerNode({ computerUse: initial })])
      .mockResolvedValue([macComputerNode({ computerUse: upgraded })]);
    const tool = createVisionComputerTool();
    await tool.execute("before-upgrade", {
      action: "screenshot",
      node: "mac-1",
      ...gatewayOptions,
    });
    expect(readActionEnum(tool)).toContain("list_windows");
    expect(readActionEnum(tool)).not.toContain("launch_app");

    await tool.execute("after-upgrade", { action: "screenshot", node: "mac-1" });
    expect(listNodesMock).toHaveBeenLastCalledWith(
      expect.objectContaining(gatewayOptions),
      undefined,
    );
    expect(readActionEnum(tool)).toContain("launch_app");
    expect(readActionEnum(tool)).not.toContain("list_windows");
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

  it("refreshes a prepared schema from the Gateway override target", async () => {
    const remoteCapabilities = v2Descriptor(["screenshot", "launch_app", "get_accessibility_tree"]);
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: remoteCapabilities })]);
    const tool = createVisionComputerTool({
      pairedNodeComputerUse: {
        actions: ["screenshot", "list_windows", "get_window_state"],
        guidanceCapabilities: v2Descriptor(["screenshot", "list_windows", "get_window_state"]),
      },
    });

    expect(readActionEnum(tool)).toContain("list_windows");
    expect(readActionEnum(tool)).not.toContain("launch_app");
    for (const field of ["query", "depth", "maxElements"]) {
      expect(tool.parameters).toHaveProperty(
        `properties.${field}.description`,
        expect.stringContaining("get_window_state with windowRef"),
      );
    }

    await tool.execute("remote-observe", {
      action: "screenshot",
      gatewayUrl: "wss://gateway.example",
      gatewayToken: "remote-token",
    });

    expect(listNodesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "wss://gateway.example",
        gatewayToken: "remote-token",
      }),
      undefined,
    );
    expect(readActionEnum(tool)).toEqual([
      "screenshot",
      "launch_app",
      "get_accessibility_tree",
      "wait",
      "take_control",
    ]);
    for (const field of ["query", "depth", "maxElements"]) {
      expect(tool.parameters).toHaveProperty(
        `properties.${field}.description`,
        expect.stringContaining("get_accessibility_tree"),
      );
    }
    await tool.execute("legacy-tree", {
      action: "get_accessibility_tree",
      query: "Save",
      depth: 10,
      maxElements: 100,
    });
    expect(readLastComputerActParams()).toEqual({
      action: "get_accessibility_tree",
      query: "Save",
      depth: 10,
      maxElements: 100,
    });
  });

  it("advertises execution-owned actions only with an attempt cleanup owner", async () => {
    const actions: ComputerUseV2ActionName[] = [
      "screenshot",
      "browser_download",
      "start_recording",
    ];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);

    const withoutCleanup = createVisionComputerTool();
    await withoutCleanup.execute("bind-without-cleanup", { action: "screenshot" });
    expect(readActionEnum(withoutCleanup)).toEqual(["screenshot", "wait", "take_control"]);

    const withCleanup = createVisionComputerTool({ registerRunCleanup: () => {} });
    await withCleanup.execute("bind-with-cleanup", { action: "screenshot" });
    expect(readActionEnum(withCleanup)).toEqual([...actions, "wait", "take_control"]);
  });

  it.each([
    {
      name: "missing screenshot capability",
      actions: ["list_apps"],
      error: "does not advertise action wait",
      captures: 0,
    },
    {
      name: "denied screenshot transport",
      actions: ["screenshot"],
      error: "snapshot policy denied",
      captures: 1,
    },
  ] as const)("keeps $name authoritative for local wait", async ({ actions, error, captures }) => {
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor([...actions]) })]);
    callGatewayToolMock.mockRejectedValue(new Error("snapshot policy denied"));
    const tool = createVisionComputerTool();

    await expect(tool.execute("wait", { action: "wait", duration: 0 })).rejects.toThrow(error);

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
      const actions: ComputerUseV2ActionName[] = [
        "get_window_state",
        "left_click",
        "left_click_drag",
        "zoom",
      ];
      listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
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
      callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
        const request = body as ComputerActBody;
        if (request.command !== COMPUTER_ACT_COMMAND) {
          return screenshotPayload();
        }
        return request.params?.action === "get_window_state"
          ? { payload: { ok: true, observation, details: { coordinateSpace } } }
          : { payload: { ok: true } };
      });
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
      listNodesMock.mockResolvedValue([
        macComputerNode({ computerUse: v2Descriptor(["get_window_state"]) }),
      ]);
      callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
        const request = body as ComputerActBody;
        if (
          request.command !== COMPUTER_ACT_COMMAND ||
          !Value.Check(releasedWindowStateSchema, request.params)
        ) {
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
    },
  );

  it("rejects a non-boolean window screenshot option", async () => {
    listNodesMock.mockResolvedValue([
      macComputerNode({ computerUse: v2Descriptor(["get_window_state"]) }),
    ]);
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
      listNodesMock.mockResolvedValue([
        macComputerNode({ computerUse: v2Descriptor(["get_window_state", "left_click"]) }),
      ]);
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

  it("rejects stale semantic references before dispatch", async () => {
    const actions: ComputerUseV2ActionName[] = ["get_window_state", "set_value"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    callGatewayToolMock.mockResolvedValue({
      payload: {
        ok: true,
        observation: { kind: "window", observationId: "observation-current" },
      },
    });
    const tool = createVisionComputerTool();
    await tool.execute("observe", { action: "get_window_state", windowRef: "window-1" });
    callGatewayToolMock.mockClear();

    await expect(
      tool.execute("write", {
        action: "set_value",
        windowRef: "window-1",
        elementRef: "element-1",
        observationId: "observation-stale",
        value: "hello",
        deliveryMode: "background",
      }),
    ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it.each(["inspect", "accept"])(
    "captures an after-image only for a dialog mutation: %s",
    async (dialogAction) => {
      listNodesMock.mockResolvedValue([
        macComputerNode({ computerUse: v2Descriptor(["browser_dialog"]) }),
      ]);
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
    const actions: ComputerUseV2ActionName[] = ["get_browser_state", "browser_pointer"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    callGatewayToolMock.mockResolvedValueOnce({
      payload: {
        ok: true,
        observation: { kind: "browser", observationId: "browser-observation-1" },
        details: {
          browserRef: "browser-1",
          pageRef: "page-1",
          elements: [{ elementRef: "element-1" }, { elementRef: "element-2" }],
        },
      },
    });
    const tool = createVisionComputerTool();

    await tool.execute("observe-browser", {
      action: "get_browser_state",
      browserRef: "browser-1",
      pageRef: "page-1",
      snapshotFormat: "dom_refs_v1",
      includeScreenshot: true,
    });
    expect(readLastComputerActParams()).toEqual({
      action: "get_browser_state",
      browserRef: "browser-1",
      pageRef: "page-1",
      snapshotFormat: "dom_refs_v1",
      includeScreenshot: true,
    });
    expect(tool.parameters).toHaveProperty(
      "properties.query.description",
      expect.stringContaining("get_browser_state: requires snapshotFormat=semantic_v2"),
    );

    callGatewayToolMock.mockImplementation(async (_method, _opts, body) =>
      (body as ComputerActBody).command === COMPUTER_ACT_COMMAND
        ? { payload: { ok: true, effect: "confirmed" } }
        : screenshotPayload(),
    );
    await tool.execute("drag-browser", {
      action: "browser_pointer",
      browserRef: "browser-1",
      pageRef: "page-1",
      observationId: "browser-observation-1",
      pointerAction: "drag",
      inputRoute: "dom_event",
      elementRef: "element-1",
      destinationElementRef: "element-2",
    });
    expect(readLastComputerActParams()).toEqual({
      action: "browser_pointer",
      browserRef: "browser-1",
      pageRef: "page-1",
      observationId: "browser-observation-1",
      pointerAction: "drag",
      inputRoute: "dom_event",
      elementRef: "element-1",
      destinationElementRef: "element-2",
    });
  });

  it("routes an observation-bound element click without requiring coordinates", async () => {
    const actions: ComputerUseV2ActionName[] = ["get_window_state", "left_click"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      const request = body as ComputerActBody;
      if (request.command !== COMPUTER_ACT_COMMAND) {
        return screenshotPayload();
      }
      if (request.params?.action === "get_window_state") {
        return {
          payload: {
            ok: true,
            observation: {
              kind: "window",
              observationId: "observation-1",
            },
          },
        };
      }
      return { payload: { ok: true, effect: "confirmed" } };
    });
    const tool = createVisionComputerTool();
    await tool.execute("observe", { action: "get_window_state", windowRef: "window-1" });

    await expect(
      tool.execute("click", {
        action: "left_click",
        windowRef: "window-1",
        elementRef: "element-1",
        observationId: "observation-1",
        deliveryMode: "background",
      }),
    ).resolves.toBeDefined();
    expect(readLastComputerActParams("left_click")).toEqual({
      action: "left_click",
      screenIndex: 0,
      refWidth: EFFECTIVE_REF_WIDTH,
      windowRef: "window-1",
      elementRef: "element-1",
      observationId: "observation-1",
      deliveryMode: "background",
    });
  });

  it("maps the recording family through opaque resource parameters", async () => {
    const actions: ComputerUseV2ActionName[] = [
      "get_recording_state",
      "start_recording",
      "stop_recording",
      "replay_trajectory",
    ];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    const tool = createVisionComputerTool({ registerRunCleanup: () => {} });
    const resourceHandle = "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000";

    await tool.execute("record", { action: "start_recording", recordVideo: true });
    expect(readLastComputerActParams()).toEqual({ action: "start_recording", recordVideo: true });
    await tool.execute("replay", {
      action: "replay_trajectory",
      resourceHandle,
      delayMs: 25,
      stopOnError: false,
    });
    expect(readLastComputerActParams()).toEqual({
      action: "replay_trajectory",
      resourceHandle,
      delayMs: 25,
      stopOnError: false,
    });
  });

  it("closes the exact host execution through attempt-owned cleanup", async () => {
    const actions: ComputerUseV2ActionName[] = ["start_recording"];
    listNodesMock.mockResolvedValue([macComputerNode({ computerUse: v2Descriptor(actions) })]);
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createVisionComputerTool({
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });

    await tool.execute("record", { action: "start_recording" });
    const start = callGatewayToolMock.mock.calls
      .map((call) => call[2] as ComputerActBody)
      .findLast((body) => body.command === COMPUTER_ACT_COMMAND);
    if (!start?.params) {
      throw new Error("missing start_recording node invocation");
    }
    const executionId = start.params.executionId;
    expect(executionId).toEqual(expect.any(String));

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
  it("loads paired capabilities only for an exposed ordinary paired surface", async () => {
    const sessionTransport = {
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
      { computerAllowed: true, modelHasVision: true, computerTransport: sessionTransport },
      { computerAllowed: true, modelHasVision: true, computerTransport: null },
    ]) {
      expect(await loadPairedComputerUseAvailabilityForSurface(params)).toBeUndefined();
    }
    expect(listNodesMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an existing wait", ["screenshot", "wait"]],
    ["no screenshot", ["list_windows"]],
  ] as const)("preserves the effective action list with %s", (_name, actions) => {
    const tool = createComputerTool({
      transport: {
        computerUse: v2Descriptor([...actions]),
        resolveNode: async () => ({ nodeId: "session-desktop" }),
        invoke: async () => undefined,
      },
    });
    expect(readActionEnum(tool)).toEqual(
      actions.some((action) => action === "screenshot") ? [...actions, "take_control"] : actions,
    );
  });

  it("keeps override-compatible v1 actions alongside prepared paired v2 actions", () => {
    const tool = createComputerTool({
      pairedNodeComputerUse: {
        actions: ["screenshot", "list_windows"],
        guidanceCapabilities: v2Descriptor(["screenshot", "list_windows"]),
      },
    });

    expect(readActionEnum(tool)).toEqual(
      expect.arrayContaining(["screenshot", "left_click", "list_windows", "wait"]),
    );
    expect(readActionEnum(tool)).not.toContain("launch_app");
  });

  it("keeps model input free of native provider fields", () => {
    const schema = JSON.stringify(createComputerTool().parameters);
    for (const nativeField of [
      "providerTool",
      "arguments",
      "binaryPath",
      "socketPath",
      "session",
      "driverArgs",
      "output_dir",
      "destinationRoot",
    ]) {
      expect(schema).not.toContain(`"${nativeField}":`);
    }
  });

  it("explains browser discovery and required reference pairs before execution", () => {
    const tool = createComputerTool({
      transport: {
        computerUse: v2Descriptor(["list_windows", "get_browser_state", "browser_prepare"]),
        resolveNode: async () => ({ nodeId: "session-desktop" }),
        invoke: async () => undefined,
      },
    });
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
  });

  it("does not describe held-key input when the selected session only supports taps", () => {
    const tool = createComputerTool({
      transport: {
        computerUse: v2Descriptor(["screenshot", "key"]),
        resolveNode: async () => ({ nodeId: "session-desktop" }),
        invoke: async () => undefined,
      },
    });
    expect(JSON.stringify(tool.parameters)).not.toContain("hold_key");
    expect(readActionEnum(tool)).toContain("wait");
    expect(JSON.stringify(createComputerTool().parameters)).toContain("hold_key");
  });

  it("publishes Codex-compatible fixed-size coordinate arrays", () => {
    const properties = (
      createComputerTool().parameters as {
        properties?: Record<string, Record<string, unknown>>;
      }
    ).properties;

    for (const key of ["coordinate", "startCoordinate"] as const) {
      const schema = properties?.[key];
      if (!schema) {
        throw new Error(`missing ${key} schema`);
      }
      expect(schema).toMatchObject({
        type: "array",
        items: { type: "integer", minimum: 0 },
        minItems: 2,
        maxItems: 2,
      });
      expect(Array.isArray(schema.items)).toBe(false);
      expect(schema).not.toHaveProperty("additionalItems");
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
  it("expires coordinates once the final context drops the tracked image", () => {
    const contextEpoch = trackedContextEpoch(0);

    expect(
      invalidateComputerFrameIfMissing({
        contextEpoch,
        messages: [computerToolResult("shot-1", [{ type: "text", text: "compacted" }])],
      }),
    ).toBe(true);
    expect(contextEpoch).toEqual({ value: 1 });
    expect(invalidateComputerFrameIfMissing({ contextEpoch, messages: [] })).toBe(false);
    expect(contextEpoch.value).toBe(1);
  });

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
    [
      "expires coordinates when image input is disabled at the model boundary",
      trackedContextEpoch(3),
      [screenshotToolResult()],
      true,
      { value: 4 },
    ],
    [
      "expires coordinates when middleware swaps the tracked screenshot",
      trackedContextEpoch(5),
      [screenshotToolResult("AQ==")],
      undefined,
      { value: 6 },
    ],
    [
      "cleans up an orphaned image identity",
      { value: 8, frameImageIdentity: imageIdentity(TINY_PNG_BASE64) },
      [],
      undefined,
      { value: 9 },
    ],
  ])("%s", (_name, contextEpoch, messages, imagesBlocked, expected) => {
    expect(invalidateComputerFrameIfMissing({ contextEpoch, messages, imagesBlocked })).toBe(true);
    expect(contextEpoch).toEqual(expected);
  });
});
