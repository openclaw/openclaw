import { expect, it } from "vitest";
import { summarizeRetentionHeap } from "../../scripts/lib/control-ui-retention.ts";

it("distinguishes live Solid owners, disposed owners, and detached native DOM nodes", () => {
  // V8 captureNumericValue uses a number -> internal value -> decimal string
  // edge. Owners are plain objects in the production runtime, not constructors.
  const strings = [
    "Object",
    "_parent",
    "De",
    "He",
    "R",
    "smi number",
    "value",
    "0",
    "64",
    "HTMLDivElement",
    "null",
    "system / Hole",
  ];
  const nodes = [
    0, 0, 1, 64, 4, 0, 0, 0, 2, 64, 4, 0, 1, 5, 3, 0, 1, 0, 1, 5, 4, 0, 1, 0, 2, 7, 5, 16, 0, 0, 2,
    8, 6, 16, 0, 0, 3, 9, 7, 112, 0, 2, 3, 9, 8, 112, 0, 1, 3, 10, 9, 0, 0, 0, 0, 0, 10, 32, 1, 0,
    0, 0, 11, 64, 4, 0, 3, 11, 12, 0, 0, 0,
  ];
  const edges = [
    0, 1, 48, 0, 2, 48, 0, 3, 48, 0, 4, 12, 0, 1, 48, 0, 2, 48, 0, 3, 48, 0, 4, 18, 1, 6, 24, 1, 6,
    30, 0, 1, 48, 0, 1, 66, 0, 2, 48, 0, 3, 48, 0, 4, 66,
  ];
  const summary = summarizeRetentionHeap({
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count", "detachedness"],
        node_types: [["object", "number", "string", "native"]],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [["property", "internal"]],
      },
    },
    nodes,
    edges,
    strings,
  });
  expect(summary).toEqual({
    caches: {},
    detachedNodes: 1,
    detachedBytes: 112,
    detached: { HTMLDivElement: { count: 1, bytes: 112 } },
    solidOwners: 2,
    solidDisposedOwners: 1,
    solidUnknownStateOwners: 0,
    solidAllocationTemplates: 1,
    solidLiveOwners: 1,
  });
});
