import { describe, expect, it } from "vitest";
import { isLeakedProtocolLine, stripLeakedProtocolLines } from "./protocol-noise.js";

describe("protocol noise sanitization", () => {
  it("detects leaked protocol lines", () => {
    expect(isLeakedProtocolLine("user to=functions.session_status commentary accidental")).toBe(
      true,
    );
    expect(isLeakedProtocolLine("assistant to=final code NO_REPLY")).toBe(true);
    expect(isLeakedProtocolLine("assistant final hello")).toBe(true);
    expect(isLeakedProtocolLine("regular user text")).toBe(false);
  });

  it("strips leaked protocol lines outside code fences", () => {
    const input = [
      "user to=functions.session_status commentary accidental againjson {}",
      "assistant to=final code NO_REPLY",
      "",
      "Please fix this.",
    ].join("\n");
    expect(stripLeakedProtocolLines(input)).toBe("Please fix this.");
  });

  it("keeps protocol-looking text inside fenced code blocks", () => {
    const input = ["```txt", "assistant to=final code NO_REPLY", "```", "", "Explain this."].join(
      "\n",
    );
    expect(stripLeakedProtocolLines(input)).toBe(input);
  });
});
