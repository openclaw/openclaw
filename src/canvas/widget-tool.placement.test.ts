import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { createBoardPutCaller } from "./widget-tool.test-support.js";

beforeEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("show_widget placement", () => {
  it.each([
    ["explicit null", null],
    ["literal null", "null"],
  ])(
    "accepts %s as a placement anchor and omits it from the first widget put",
    async (_label, after) => {
      const { mock: callGatewayMock, callGateway } = createBoardPutCaller();
      const tool = createShowWidgetTool({
        agentSessionKey: "agent:main:first-widget",
        inlineHostEnabled: false,
        callGateway,
      });
      const args = {
        title: "First widget",
        widget_code: "<p>first</p>",
        pin: true,
        name: "first-widget",
        after,
      };

      expect(Value.Check(tool.parameters, args)).toBe(true);
      await tool.execute("first-widget", args);

      expect(callGatewayMock).toHaveBeenCalledWith(
        "board.widget.put",
        expect.not.objectContaining({ placement: expect.anything() }),
      );
    },
  );

  it("keeps a genuine anchor and a widget named null", async () => {
    const { mock: callGatewayMock, callGateway } = createBoardPutCaller();
    const tool = createShowWidgetTool({
      agentSessionKey: "agent:main:anchored-widget",
      inlineHostEnabled: false,
      callGateway,
    });

    await tool.execute("anchored-widget", {
      title: "Anchored widget",
      widget_code: "<p>anchored</p>",
      pin: true,
      name: "null",
      after: "clock",
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      "board.widget.put",
      expect.objectContaining({ name: "null", placement: { after: "clock" } }),
    );
  });
});
