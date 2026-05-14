import { describe, expect, it } from "vitest";
import {
  collectRuntimePacketLintErrorsFromSources,
  collectRuntimePacketLintReport,
} from "../../scripts/check-runtime-packet-lint.mjs";

describe("check-runtime-packet-lint", () => {
  it("passes against the checked-in runtime packet lint coverage", () => {
    expect(collectRuntimePacketLintReport().ok).toBe(true);
  });

  it("flags missing side-effect gate snippets", () => {
    const sourceByPath = new Map([
      [
        "src/agents/tools/runtime-packet-lint.ts",
        "validateRuntimeExecutionPacket readRuntimeExecutionPacket stripRuntimeExecutionPackets foundationRefs confidenceLoop SIDE_EFFECT_TASK_RE",
      ],
      ["src/agents/tools/sessions-spawn-tool.ts", "validateRuntimeExecutionPacket"],
      ["src/agents/tools/sessions-spawn-tool.test.ts", "requires an executionPacket"],
    ]);

    expect(
      collectRuntimePacketLintErrorsFromSources(sourceByPath, [
        {
          id: "sessions-spawn-side-effect-gate",
          filePath: "src/agents/tools/sessions-spawn-tool.ts",
          requiredSnippets: ["validateRuntimeExecutionPacket", "taskText: task"],
          testPath: "src/agents/tools/sessions-spawn-tool.test.ts",
          requiredTestSnippets: [
            "rejects side-effectful spawn tasks without an execution packet",
            "requires an executionPacket",
          ],
        },
      ]),
    ).toEqual([
      'sessions-spawn-side-effect-gate: src/agents/tools/sessions-spawn-tool.ts is missing "taskText: task"',
      'sessions-spawn-side-effect-gate: src/agents/tools/sessions-spawn-tool.test.ts is missing "rejects side-effectful spawn tasks without an execution packet"',
    ]);
  });
});
