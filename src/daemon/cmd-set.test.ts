import { describe, expect, it } from "vitest";
import { parseCmdSetAssignment, renderCmdSetAssignment } from "./cmd-set.js";

const context = { delayedExpansion: false };
describe("literal task SET assignments", () => {
  it.each(["", "caret^!bang", 'quote"&|<>^()tail', "%%NAME%%", " \tvalue \t ", "café ü 空"])(
    "retains the literal assignment %j",
    (value) => {
      const line = renderCmdSetAssignment("OPENCLAW_VALUE", value).slice(4);
      expect(parseCmdSetAssignment(line, true, context)).toEqual({ key: "OPENCLAW_VALUE", value });
      expect(parseCmdSetAssignment(line, false, context)).toEqual({ key: "OPENCLAW_VALUE", value });
    },
  );
  it.each([
    '"OPENCLAW_VALUE=%REFERENCE%"',
    '"OPENCLAW_VALUE=a"&echo synthetic"',
    '"OPENCLAW_VALUE=a"^"tail"',
  ])("rejects nonliteral or ambiguous assignment %j", (line) => {
    expect(parseCmdSetAssignment(line, true, context)).toBeNull();
  });
  it("retains legacy recovery without admitting legacy expansions as effective values", () => {
    const line = '"OPENCLAW_VALUE=caret^^bang^!quote^"%%"';
    expect(parseCmdSetAssignment(line)).toEqual({
      key: "OPENCLAW_VALUE",
      value: 'caret^bang!quote"%',
    });
    expect(parseCmdSetAssignment(line, true)).toBeNull();
  });
  it.each(["\r", "\n", "\0"])("rejects nonrepresentable assignment characters", (value) => {
    expect(() => renderCmdSetAssignment("OPENCLAW_VALUE", value)).toThrow();
    expect(() => renderCmdSetAssignment(value, "synthetic")).toThrow();
  });
});
