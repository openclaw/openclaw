import { describe, expect, it } from "vitest";
import { parseLsofOutput } from "./ports.js";

describe("parseLsofOutput", () => {
  it("parses listener records with pid and command", () => {
    const output = ["p123", "cnode", "p456", "cpython"].join("\n");

    expect(parseLsofOutput(output)).toEqual([
      { pid: 123, command: "node" },
      { pid: 456, command: "python" },
    ]);
  });

  it("ignores malformed pid records and keeps valid listeners", () => {
    const output = ["pnot-a-number", "cnode", "p789", "cbun"].join("\n");

    expect(parseLsofOutput(output)).toEqual([{ pid: 789, command: "bun" }]);
  });

  it("supports listeners without command metadata", () => {
    expect(parseLsofOutput("p321")).toEqual([{ pid: 321 }]);
  });
});
