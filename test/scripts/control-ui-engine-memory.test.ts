import { describe, expect, it } from "vitest";
import { summarizeWebKitHeap } from "../../scripts/lib/control-ui-engine-memory.ts";

describe("WebKit Inspector heap protocol", () => {
  it("counts self sizes and native DOM wrappers independently from object/internal flags", () => {
    // WebKit Inspector v3: [id, size, class name index, flags]. A DOM wrapper
    // does not need the object bit, and the synthetic root is not an allocation.
    const result = summarizeWebKitHeap({
      version: 3,
      type: "Inspector",
      nodeClassNames: ["<root>", "Object", "HTMLDivElement", "FunctionCodeBlock"],
      nodes: [0, 0, 0, 0, 1, 32, 1, 2, 2, 48, 2, 4, 3, 96, 3, 1, 4, 48, 2, 4],
    });
    expect(result).toEqual({
      snapshot: {
        bytes: 224,
        nodes: 4,
        classes: {
          Object: { count: 1, bytes: 32, internal: 0, objects: 1, dom: 0, native: null },
          HTMLDivElement: { count: 2, bytes: 96, internal: 0, objects: 0, dom: 2, native: null },
          FunctionCodeBlock: { count: 1, bytes: 96, internal: 1, objects: 0, dom: 0, native: null },
        },
      },
      domNodes: [
        { id: 2, name: "HTMLDivElement", bytes: 48 },
        { id: 4, name: "HTMLDivElement", bytes: 48 },
      ],
    });
  });

  it("rejects a changed wire format rather than reporting misleading heap totals", () => {
    expect(() =>
      summarizeWebKitHeap({ version: 4, type: "Inspector", nodes: [], nodeClassNames: [] }),
    ).toThrow("Expected WebKit Inspector version 3");
  });
});
