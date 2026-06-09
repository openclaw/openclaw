import { describe, expect, it } from "vitest";
import {
  REALTIME_VOICE_DESCRIBE_VIEW_TOOL,
  REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
} from "./describe-view-tool.js";

describe("describe_view tool", () => {
  it("has the correct name constant", () => {
    expect(REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME).toBe("describe_view");
    expect(REALTIME_VOICE_DESCRIBE_VIEW_TOOL.name).toBe("describe_view");
  });

  it("is a function-type tool with optional focus parameter", () => {
    expect(REALTIME_VOICE_DESCRIBE_VIEW_TOOL.type).toBe("function");
    const params = REALTIME_VOICE_DESCRIBE_VIEW_TOOL.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.type).toBe("object");
    expect(params.required).toStrictEqual([]);
    expect(params.properties).toHaveProperty("focus");
  });
});
