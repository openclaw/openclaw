import { describe, expect, it } from "vitest";
import {
  boardWidgetActionParams,
  normalizeBoardWidgetActionBindings,
} from "./board-action-bindings.js";
import { boardDeclarationIsSubset, normalizeBoardWidgetDeclared } from "./board-capabilities.js";

const binding = {
  name: "play",
  actionId: "device-controls.audio",
  params: { nodeId: "mac-fixture", operationId: "fixture-id" },
};
describe("target-bound board actions", () => {
  it("canonicalizes fixed targets and retains the declaration", () => {
    const value = normalizeBoardWidgetDeclared({ actionBindings: [binding] });
    expect(value).toEqual({ actionBindings: [binding] });
    expect(
      boardWidgetActionParams(binding, { notes: [{ frequencyHz: 440, durationMs: 100 }] }),
    ).toEqual({ ...binding.params, notes: [{ frequencyHz: 440, durationMs: 100 }] });
  });
  it.each(["nodeId", "operationId", "constructor", "__proto__"])(
    "rejects dynamic override of %s",
    (key) => {
      expect(() =>
        boardWidgetActionParams(binding, Object.fromEntries([[key, "different"]])),
      ).toThrow(/cannot override/);
    },
  );
  it.each([
    [binding, binding],
    [{ ...binding, params: { nodeId: { nested: "target" } } }],
    [{ ...binding, params: { nodeId: "x".repeat(8193) } }],
    [{ ...binding, params: Object.fromEntries([["__proto__", "bad"]]) }],
  ])("rejects ambiguous, nested or oversized definitions", (first, ...rest) => {
    expect(() => normalizeBoardWidgetActionBindings([first, ...rest])).toThrow(
      /Invalid named actions/,
    );
  });
  it("requires a renewed decision for any fixed target or operation change", () => {
    const original = normalizeBoardWidgetDeclared({ actionBindings: [binding] });
    const updated = normalizeBoardWidgetDeclared({
      actionBindings: [{ ...binding, params: { ...binding.params, nodeId: "other-mac" } }],
    });
    expect(boardDeclarationIsSubset(original, original)).toBe(true);
    expect(boardDeclarationIsSubset(updated, original)).toBe(false);
    expect(boardDeclarationIsSubset(undefined, original)).toBe(false);
  });
});
