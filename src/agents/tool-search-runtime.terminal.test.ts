import { describe, expect, it, vi } from "vitest";
import { formatToolSearchControlResult } from "./tool-search-runtime.js";
import {
  createToolSearchTools,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
} from "./tool-search.js";
import { createRuntime, fakeTool } from "./tool-search.test-support.js";
import { jsonResult } from "./tools/common.js";

describe("Tool Search terminal results", () => {
  it("preserves a terminal target result on the direct control", async () => {
    const target = fakeTool("terminal_action");
    target.execute = vi.fn(async () => ({
      ...jsonResult({ outcome: "terminal" }),
      terminate: true,
    }));
    const { catalogRef, config } = createRuntime([target]);
    const callTool = createToolSearchTools({ catalogRef, config }).find(
      (tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME,
    );

    const result = await callTool!.execute("terminal-parent", { id: target.name });

    expect(result.terminate).toBe(true);
    expect(result.details).toMatchObject({ result: { terminate: true } });
  });

  it.each([
    { secondTerminal: true, expectedTerminal: true },
    { secondTerminal: false, expectedTerminal: undefined },
  ])(
    "uses all-terminal semantics for code controls: $secondTerminal",
    async ({ secondTerminal, expectedTerminal }) => {
      const first = fakeTool("first_action");
      first.execute = vi.fn(async () => ({ ...jsonResult({ first: true }), terminate: true }));
      const second = fakeTool("second_action");
      second.execute = vi.fn(async () => ({
        ...jsonResult({ second: true }),
        ...(secondTerminal ? { terminate: true } : {}),
      }));
      const { catalogRef, config } = createRuntime([first, second]);
      const codeTool = createToolSearchTools({ catalogRef, config }).find(
        (tool) => tool.name === TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      );

      const result = await codeTool!.execute("code-parent", {
        code: `
          await openclaw.tools.call("first_action", {});
          return await openclaw.tools.call("second_action", {});
        `,
      });

      expect(result.terminate).toBe(expectedTerminal);
      expect(first.execute).toHaveBeenCalledOnce();
      expect(second.execute).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["terminal then ordinary", ["terminal_action", "ordinary_action"]],
    ["ordinary then terminal", ["ordinary_action", "terminal_action"]],
  ] as const)(
    "uses monotonic terminal semantics for a settled Code Mode cell: %s",
    async (_, order) => {
      const terminal = fakeTool("terminal_action");
      terminal.execute = vi.fn(async () => ({
        ...jsonResult({ outcome: "terminal" }),
        terminate: true,
      }));
      const ordinary = fakeTool("ordinary_action");
      const { runtime } = createRuntime([terminal, ordinary]);
      const parentToolCallId = "code-mode-parent";

      for (const name of order) {
        await runtime.call(name, {}, { parentToolCallId, terminalAggregation: "any" });
      }
      const result = formatToolSearchControlResult({ status: "completed" }, runtime, {
        parentToolCallId,
        terminalBatchStatus: "completed",
      });

      expect(result.terminate).toBe(true);
    },
  );
});
