import { describe, expect, it } from "vitest";
import { unwrapToolCallForDisplay } from "./tool-display-call.js";

describe("Tool Search display input", () => {
  it.each([
    [" web_search ", "web_search"],
    ["openclaw:core:read", "read"],
    ["mcp:docs:mcp__docs__search", "mcp__docs__search"],
    ["client:client:exec", "exec"],
    ["custom:tool", "custom:tool"],
  ])("resolves %s without changing the original call", (id, name) => {
    const args = Object.freeze({ query: "OpenClaw release notes" });
    const call = Object.freeze({ name: "tool_call", args: Object.freeze({ id, args }) });
    expect(unwrapToolCallForDisplay(call)).toEqual({ name, args });
    expect(call.args).toEqual({ id, args });
  });

  it.each([undefined, null, [], "{}", {}, { id: "" }, { id: " " }, { id: 3 }])(
    "leaves invalid dispatcher input %j unchanged",
    (args) => {
      const call = { name: "tool_call", args };
      expect(unwrapToolCallForDisplay(call)).toBe(call);
    },
  );

  it.each(["web_search", "tool_search", "tool_describe", undefined])(
    "leaves %s unchanged",
    (name) => {
      const call = { name, args: { id: "read", args: { path: "/workspace/README.md" } } };
      expect(unwrapToolCallForDisplay(call)).toBe(call);
    },
  );

  it.each([undefined, null, [], "input", 3, new Date(0)])(
    "discards non-object inner input %j",
    (args) => {
      expect(unwrapToolCallForDisplay({ name: "tool_call", args: { id: "read", args } })).toEqual({
        name: "read",
        args: {},
      });
    },
  );
});
