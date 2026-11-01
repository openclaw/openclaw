// @vitest-environment node
import { expect, it } from "vitest";
import { parseSessionLog } from "./helpers.ts";

it("parses tool summaries from compact session logs", () => {
  const { toolInfo: res } = parseSessionLog({
    timestamp: 0,
    role: "assistant",
    content: "[Tool: read]\n[Tool Result]\n[Tool: exec]\n[Tool: read]\n[Tool Result]",
  });
  expect(res.summary).toBe("Tools: read×2, exec×1 (3 calls)");
  expect(res.cleanContent).toBe("");
  expect(res.tools[0]).toEqual(["read", 2]);
});
