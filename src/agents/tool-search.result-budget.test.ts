import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { installToolResultContextGuard } from "./embedded-agent-runner/tool-result-context-guard.js";
import { Agent, type AgentMessage } from "./runtime/index.js";
import { wrapToolDefinition } from "./sessions/tools/tool-definition-wrapper.js";
import { resolveToolResultBudget, toolResultFitsBudget } from "./tool-result-limits.js";
import { singleToolCallStreamFn, toolSearchTestModel } from "./tool-search-loop.test-support.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  TOOL_CALL_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

it.each([
  { contextWindow: 320_000, image: false, initialLimit: 49, smallerLimit: undefined },
  { contextWindow: 32_000, image: false, initialLimit: 49, smallerLimit: 20 },
  { contextWindow: 32_000, image: true, initialLimit: 24, smallerLimit: 14 },
])(
  "delivers complete network pages or restarts safely: $contextWindow context, image=$image",
  async ({ contextWindow, image, initialLimit, smallerLimit }) => {
    const lines = Array.from({ length: 78 }, (_, index) => `${index + 1}: ${"x".repeat(500)}`);
    let calls = 0;
    const target: AnyAgentTool = {
      name: "read_page",
      label: "Read page",
      description: "Read numbered document lines",
      parameters: {
        type: "object",
        properties: { start: { type: "number" }, limit: { type: "number" } },
        required: ["start", "limit"],
      },
      resultContentSource: "network",
      execute: async (_id, input: { start: number; limit: number }) => {
        calls++;
        const end = Math.min(78, input.start - 1 + input.limit);
        const result = jsonResult({
          next_start_line: end < 78 ? end + 1 : null,
          text: lines.slice(input.start - 1, end).join("\n"),
        });
        if (image) {
          result.content.push({ type: "image", data: "AA==", mimeType: "image/png" });
        }
        return result;
      },
    };
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });
    const control = expectDefined(
      createToolSearchTools({ catalogRef, modelContextWindowTokens: contextWindow }).find(
        (tool) => tool.name === TOOL_CALL_RAW_TOOL_NAME,
      ),
      "dispatch control",
    );
    const read = async (start: number, limit: number) => {
      let sent: AgentMessage[] = [];
      const stream = singleToolCallStreamFn({
        id: `page-${start}-${limit}`,
        name: TOOL_CALL_RAW_TOOL_NAME,
        arguments: { id: target.name, args: { start, limit } },
      });
      const agent = new Agent({
        initialState: {
          model: { ...toolSearchTestModel, contextWindow },
          tools: toToolDefinitions([control]).map((tool) => wrapToolDefinition(tool)),
        },
        streamFn: (model, context, options) => {
          sent = context.messages;
          return stream(model, context, options);
        },
      });
      const cleanup = installToolResultContextGuard({ agent, contextWindowTokens: contextWindow });
      try {
        await agent.prompt("Read this page without skipping any lines.");
      } finally {
        cleanup();
      }
      const message = expectDefined(
        sent.find((item) => item.role === "toolResult"),
        "model-facing tool result",
      );
      const text = message.content.find((block) => block.type === "text");
      if (text?.type !== "text") {
        throw new Error("Missing model-facing result");
      }
      expect(toolResultFitsBudget(text.text, resolveToolResultBudget(contextWindow))).toBe(true);
      expect(text.text).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
      expect(text.text).toMatch(/<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[a-f0-9]{16}">>>/);
      expect(message.content.filter((block) => block.type === "image")).toHaveLength(image ? 1 : 0);
      return text.text.split("\n---\n")[1]!.split("\n<<<END_EXTERNAL_UNTRUSTED_CONTENT")[0]!;
    };

    let first = await read(1, initialLimit);
    expect(calls).toBe(1);
    let limit = initialLimit;
    if (smallerLimit) {
      // Never expose a cursor from a page whose body was not delivered.
      expect(first).not.toContain("next_start_line");
      expect(first).toContain("same starting position");
      limit = smallerLimit;
      first = await read(1, limit);
    }
    const received: string[] = [];
    let page = first;
    while (true) {
      const envelope = JSON.parse(page);
      const body = JSON.parse(envelope.result.content[0].text);
      received.push(...body.text.split("\n"));
      if (body.next_start_line === null) {
        break;
      }
      page = await read(body.next_start_line, limit);
    }
    expect(received).toEqual(lines);
  },
);
