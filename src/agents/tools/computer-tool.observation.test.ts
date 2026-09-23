import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getImageMetadata } from "../../media/image-ops.js";
import { createSolidPngBuffer } from "../../plugin-sdk/test-helpers/image-fixtures.js";
import type { ComputerActResult } from "../../plugins/computer-use-contract.js";
import type { ComputerToolTransport } from "./computer-tool-shared.js";
import {
  createVisionComputerTool,
  resetComputerToolMocks,
  sleepMock,
  TINY_PNG_BASE64,
  v2Descriptor,
} from "./computer-tool.test-helpers.js";

const actionResult: ComputerActResult = {
  ok: true,
  effect: "confirmed",
  details: { route: "accessibility_action", deliveryMode: "background", evidence: "verified" },
};

function observationResult(index: number): ComputerActResult {
  return {
    ok: true,
    observation: {
      kind: "window",
      observationId: `observation-${index}`,
      elements: [
        {
          elementRef: `element-${index}`,
          role: "button",
          label: "Save",
          bounds: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
      base64: TINY_PNG_BASE64,
      format: "png",
      width: 1,
      height: 1,
    },
    details: { coordinateSpace: "image-pixels" },
  };
}

function createObservedTool(
  options: {
    inline?: boolean;
    followUp?: () => ComputerActResult;
  } = {},
) {
  let observations = 0;
  let mutations = 0;
  const cache = new Map<string, ComputerActResult>();
  const computerUse = v2Descriptor(["get_window_state", "left_click"]);
  const invoke = vi.fn<ComputerToolTransport["invoke"]>(async (request) => {
    if (request.command !== "computer.act") {
      throw new Error("Unexpected desktop capture");
    }
    const key = request.idempotencyKey!;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    let result: ComputerActResult;
    if (request.commandParams.action === "get_window_state") {
      observations += 1;
      result =
        observations > 1 && options.followUp ? options.followUp() : observationResult(observations);
    } else {
      expect(request.commandParams).toMatchObject({
        action: "left_click",
        windowRef: "window-1",
        observationId: `observation-${observations}`,
      });
      if (request.commandParams.elementRef) {
        expect(request.commandParams.elementRef).toBe(`element-${observations}`);
      }
      mutations += 1;
      result = options.inline
        ? { ...observationResult(++observations), ...actionResult }
        : actionResult;
    }
    cache.set(key, result);
    return result;
  });
  const tool = createVisionComputerTool({
    idempotencyScope: "run-1",
    transport: {
      computerUse,
      resolveNode: async () => ({ nodeId: "desktop-1", computerUse }),
      invoke,
    },
  });
  const observe = () =>
    tool.execute("observe", { action: "get_window_state", windowRef: "window-1" });
  const click = (index: number, callId = `click-${index}`, signal?: AbortSignal) =>
    tool.execute(
      callId,
      {
        action: "left_click",
        windowRef: "window-1",
        observationId: `observation-${index}`,
        elementRef: `element-${index}`,
        deliveryMode: "background",
      },
      signal,
    );
  return { tool, invoke, observe, click, counts: () => ({ observations, mutations }) };
}

describe("computer targeted action observations", () => {
  beforeEach(resetComputerToolMocks);

  it("returns fresh refs and preserves input evidence without an extra model observation turn", async () => {
    const fixture = createObservedTool();
    await fixture.observe();
    const result = await fixture.click(1);

    expect(result.content.map((block) => block.type)).toEqual(["text", "text", "image"]);
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ action: "left_click", ...actionResult }),
    });
    expect(result.content[1]).toEqual({
      type: "text",
      text: JSON.stringify({
        action: "get_window_state",
        ...observationResult(2),
        observation: { ...observationResult(2).observation, base64: "[image]" },
      }),
    });
    expect(result.details).toMatchObject({
      action: "left_click",
      result: actionResult,
      followUpObservation: {
        observation: { observationId: "observation-2" },
        details: { coordinateSpace: "image-pixels" },
      },
    });
    await fixture.click(2, "click-1:observation");
    expect(fixture.counts()).toEqual({ observations: 3, mutations: 2 });
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(500, undefined);

    const requests = fixture.invoke.mock.calls.map(([request]) => request);
    const mutationRequest = expectDefined(requests[1], "first input request");
    const observationRequest = expectDefined(requests[2], "automatic observation request");
    const mutationKey = `computer.act:v1:${createHash("sha256")
      .update(JSON.stringify(["run-1", "click-1", "computer.act"]))
      .digest("hex")}`;
    expect(mutationRequest.idempotencyKey).toBe(mutationKey);
    expect(observationRequest.idempotencyKey).toMatch(/^computer\.observation:v1:/);
    expect(new Set(requests.map((request) => request.idempotencyKey)).size).toBe(5);
    expect(observationRequest.commandParams).toEqual({
      action: "get_window_state",
      executionId: mutationRequest.commandParams.executionId,
      windowRef: "window-1",
    });
    await expect(fixture.click(1, "stale")).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
    expect(fixture.counts().mutations).toBe(2);
  });

  it("keeps direct and inline observations unchanged and avoids an additional read", async () => {
    const fixture = createObservedTool({ inline: true });
    const direct = await fixture.observe();
    expect(direct.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        action: "get_window_state",
        ...observationResult(1),
        observation: { ...observationResult(1).observation, base64: "[image]" },
      }),
    });
    const inline = await fixture.click(1);
    expect(inline.content.map((block) => block.type)).toEqual(["text", "image"]);
    expect(inline.details).toMatchObject({
      action: "left_click",
      result: { ...actionResult, observation: { observationId: "observation-2" } },
    });
    expect(inline.details).not.toHaveProperty("followUpObservation");
    expect(fixture.invoke).toHaveBeenCalledTimes(2);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it.each(["image-pixels", "global-logical-points"] as const)(
    "binds the automatic observation's resized image using %s",
    async (coordinateSpace) => {
      const width = 1568;
      const height = 784;
      const fixture = createObservedTool({
        followUp: () => ({
          ...observationResult(2),
          observation: {
            ...observationResult(2).observation!,
            base64: createSolidPngBuffer(width, height, { r: 70, g: 125, b: 180 }).toString(
              "base64",
            ),
            width,
            height,
          },
          details: { coordinateSpace },
        }),
      });
      await fixture.observe();
      const result = await fixture.click(1);
      const image = result.content.find((block) => block.type === "image");
      if (!image) {
        throw new Error("Missing automatic window observation image");
      }
      const dimensions = await getImageMetadata(Buffer.from(image.data, "base64"));
      if (!dimensions) {
        throw new Error("Missing automatic window observation dimensions");
      }
      expect(dimensions.width).toBeLessThan(width);
      const coordinate: [number, number] = [
        Math.floor(dimensions.width / 2),
        Math.floor(dimensions.height / 2),
      ];
      await fixture.tool.execute("next-pixel", {
        action: "left_click",
        windowRef: "window-1",
        observationId: "observation-2",
        coordinate,
      });
      const [coordinateRequest] = expectDefined(fixture.invoke.mock.calls[3], "coordinate input");
      const sent = coordinateRequest.commandParams;
      expect(sent.x).toBeCloseTo(
        coordinate[0] * (coordinateSpace === "image-pixels" ? width / dimensions.width : 1),
      );
      expect(sent.y).toBeCloseTo(
        coordinate[1] * (coordinateSpace === "image-pixels" ? height / dimensions.height : 1),
      );
    },
  );

  it.each([
    [
      "rejected",
      () => {
        throw new Error("window closed");
      },
    ],
    [
      "read aborted",
      () => {
        throw new DOMException("read cancelled", "AbortError");
      },
    ],
    ["missing observation", () => ({ ok: true })],
    ["unsuccessful", () => ({ ok: false, details: { reason: "unavailable" } })],
  ] as const)(
    "preserves input success after a %s follow-up and expires old refs",
    async (_name, followUp) => {
      const fixture = createObservedTool({ followUp });
      await fixture.observe();
      const result = await fixture.click(1, "click", new AbortController().signal);
      expect(result.details).toMatchObject({ action: "left_click", result: actionResult });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("follow-up observation failed:"),
      });
      await expect(fixture.click(1, "stale")).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
      expect(fixture.counts()).toEqual({ observations: 2, mutations: 1 });
    },
  );

  it("keeps caller cancellation authoritative without repeating input", async () => {
    const controller = new AbortController();
    const fixture = createObservedTool({
      followUp: () => {
        controller.abort(new Error("caller cancelled"));
        controller.signal.throwIfAborted();
        return observationResult(2);
      },
    });
    await fixture.observe();
    await expect(fixture.click(1, "click", controller.signal)).rejects.toThrow("caller cancelled");
    expect(fixture.counts()).toEqual({ observations: 2, mutations: 1 });
  });

  it.each([
    {
      name: "screen input",
      input: { action: "key", text: "Return" },
      actions: ["key", "get_window_state"],
    },
    {
      name: "unavailable window observation",
      input: { action: "key", text: "Return", windowRef: "window-1" },
      actions: ["key"],
    },
    {
      name: "browser preparation",
      input: { action: "browser_prepare", windowRef: "window-1" },
      actions: ["browser_prepare", "get_window_state"],
    },
  ] as const)("retains desktop capture for $name", async ({ input, actions }) => {
    const computerUse = v2Descriptor(["screenshot", ...actions]);
    const invoke = vi.fn<ComputerToolTransport["invoke"]>(async (request) =>
      request.command === "computer.act"
        ? actionResult
        : {
            format: "png",
            base64: TINY_PNG_BASE64,
            displayFrameId: "display-1",
            width: 1,
            height: 1,
          },
    );
    const tool = createVisionComputerTool({
      transport: {
        computerUse,
        resolveNode: async () => ({ nodeId: "desktop-1", computerUse }),
        invoke,
      },
    });
    const result = await tool.execute("input", input);
    expect(invoke.mock.calls.map(([request]) => request.command)).toEqual([
      "computer.act",
      "screen.snapshot",
    ]);
    expect(result.content.some((block) => block.type === "image")).toBe(true);
    expect(sleepMock).toHaveBeenCalledWith(500, undefined);
  });
});
