import { describe, expect, it, vi } from "vitest";
import { promptResolvedAllowFrom } from "./helpers.js";

function createPrompter(inputs: string[]) {
  return {
    text: vi.fn(async () => inputs.shift() ?? ""),
    note: vi.fn(async () => undefined),
  };
}

describe("promptResolvedAllowFrom", () => {
  it("re-prompts without token until all ids are parseable", async () => {
    const prompter = createPrompter(["@alice", "123"]);
    const resolveEntries = vi.fn();

    const result = await promptResolvedAllowFrom({
      // oxlint-disable-next-line typescript/no-explicit-any
      prompter: prompter as any,
      existing: ["111"],
      token: "",
      message: "msg",
      placeholder: "placeholder",
      label: "allowlist",
      parseInputs: (value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      invalidWithoutTokenNote: "ids only",
      // oxlint-disable-next-line typescript/no-explicit-any
      resolveEntries: resolveEntries as any,
    });

    expect(result).toEqual(["111", "123"]);
    expect(prompter.note).toHaveBeenCalledWith("ids only", "allowlist");
    expect(resolveEntries).not.toHaveBeenCalled();
  });

  it("re-prompts when token resolution returns unresolved entries", async () => {
    const prompter = createPrompter(["alice", "bob"]);
    const resolveEntries = vi
      .fn()
      .mockResolvedValueOnce([{ input: "alice", resolved: false }])
      .mockResolvedValueOnce([{ input: "bob", resolved: true, id: "U123" }]);

    const result = await promptResolvedAllowFrom({
      // oxlint-disable-next-line typescript/no-explicit-any
      prompter: prompter as any,
      existing: [],
      token: "xoxb-test",
      message: "msg",
      placeholder: "placeholder",
      label: "allowlist",
      parseInputs: (value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      parseId: () => null,
      invalidWithoutTokenNote: "ids only",
      resolveEntries,
    });

    expect(result).toEqual(["U123"]);
    expect(prompter.note).toHaveBeenCalledWith("Could not resolve: alice", "allowlist");
    expect(resolveEntries).toHaveBeenCalledTimes(2);
  });
});
