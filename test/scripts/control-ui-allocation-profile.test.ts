import { expect, it } from "vitest";
import {
  summarizeControlUiAllocations,
  type ControlUiAllocationProfile,
} from "../../scripts/lib/control-ui-allocation-profile.ts";

it("accounts for each allocation sample once while preserving separate source owners", () => {
  const node = (id: number, url: string, children: ControlUiAllocationProfile["head"][] = []) => ({
    id,
    callFrame: { functionName: "render", url, lineNumber: 0, columnNumber: 0 },
    selfSize: 0,
    children,
  });
  const report = summarizeControlUiAllocations({
    head: node(1, "ui/src/app.ts", [
      node(2, "node_modules/@solidjs/signals/dist/index.js", [node(5, "")]),
      node(3, "__playwright_evaluation_script__"),
      node(4, "ui/src/app.ts"),
    ]),
    // The same source function appears on two stacks. Sample records, including
    // collected objects, remain the allocation ledger; tree sizes are not added.
    samples: [
      { nodeId: 1, size: 4096, ordinal: 1 },
      { nodeId: 5, size: 8192, ordinal: 2 },
      { nodeId: 3, size: 4096, ordinal: 3 },
      { nodeId: 4, size: 4096, ordinal: 4 },
      { nodeId: 99, size: 4096, ordinal: 5 },
    ],
  });
  expect(report.bytes).toBe(24576);
  expect(report.samples).toBe(5);
  expect(report.missingFrameBytes).toBe(4096);
  expect(report.owners).toEqual({ app: 8192, Solid: 8192, automation: 4096, unmapped: 4096 });
  expect(report.functions).toHaveLength(4);
  expect(report.files.find(({ file }) => file === "ui/src/app.ts")).toEqual({
    file: "ui/src/app.ts",
    bytes: 8192,
    samples: 2,
  });
});
