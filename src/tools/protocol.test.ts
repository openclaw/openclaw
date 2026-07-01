// Protocol tests cover tool descriptor conversion for model runtimes.
import { describe, expect, it } from "vitest";
import { toToolProtocolDescriptor, toToolProtocolDescriptors } from "./protocol.js";
import type { ToolPlanEntry } from "./types.js";

function makeEntry(
  name: string,
  description = "",
  inputSchema: Record<string, unknown> = {},
): ToolPlanEntry {
  return {
    descriptor: { name, description, inputSchema },
  } as ToolPlanEntry;
}

describe("toToolProtocolDescriptor", () => {
  it("extracts name, description, and inputSchema from a plan entry", () => {
    const entry = makeEntry("read_file", "Reads a file", {
      type: "object",
      properties: { path: { type: "string" } },
    });
    const result = toToolProtocolDescriptor(entry);
    expect(result).toEqual({
      name: "read_file",
      description: "Reads a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    });
  });
});

describe("toToolProtocolDescriptors", () => {
  it("converts a list of entries preserving order", () => {
    const entries = [makeEntry("a"), makeEntry("b"), makeEntry("c")];
    const result = toToolProtocolDescriptors(entries);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for empty input", () => {
    expect(toToolProtocolDescriptors([])).toEqual([]);
  });
});
