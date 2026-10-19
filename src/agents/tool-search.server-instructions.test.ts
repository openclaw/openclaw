import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { mcpTool } from "./code-mode.test-support.js";
import { truncateToolResultMessage } from "./embedded-agent-runner/tool-result-truncation.js";
import { resolveAutoLiveToolResultMaxChars } from "./tool-result-limits.js";
import {
  MCP_SERVER_INSTRUCTIONS_TOO_LARGE,
  mcpServerInstructionsDescribeMarker,
} from "./tool-search-runtime.js";
import { MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS } from "./tool-search-types.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";

// Longer than any per-entry cap, with the binding rule at the very end.
const researchGuidance = [
  "RESEARCH_GUIDANCE: rank binding precedents first.",
  "Background detail. ".repeat(170).trim(),
  "RESEARCH_TAIL: on monthly_quota_exceeded, never retry.",
].join("\n");
const calcGuidance = "CALC_GUIDANCE: confirm before paid runs.";

function setup(
  options: {
    researchGuidance?: string;
    modelContextWindowTokens?: number;
    researchDescription?: string;
    researchParameters?: Parameters<typeof mcpTool>[0]["parameters"];
  } = {},
) {
  const catalogRef = createToolSearchCatalogRef();
  const guidance = options.researchGuidance ?? researchGuidance;
  registerHeadlessToolSearchCatalog({
    catalogRef,
    tools: [
      mcpTool({
        name: "research__search",
        serverName: "research",
        toolName: "search",
        description: options.researchDescription ?? "Search court decisions by topic.",
        parameters: options.researchParameters,
        serverInstructions: guidance,
      }),
      mcpTool({
        name: "research__fetch",
        serverName: "research",
        toolName: "fetch",
        description: "Fetch the full text of court decisions.",
        serverInstructions: guidance,
      }),
      mcpTool({
        name: "calc__run",
        serverName: "calc",
        toolName: "run",
        description: "Run court decision value calculations.",
        serverInstructions: calcGuidance,
      }),
      mcpTool({
        name: "plain__ping",
        serverName: "plain",
        toolName: "ping",
        description: "Ping the court decision mirror.",
      }),
    ],
  });
  const tools = createToolSearchTools({
    catalogRef,
    config: { tools: { toolSearch: true } },
    modelContextWindowTokens: options.modelContextWindowTokens,
  });
  const tool = (name: string) =>
    expectDefined(
      tools.find((candidate) => candidate.name === name),
      name,
    );
  return { catalogRef, tool };
}

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("Tool Search MCP server instructions", () => {
  it("adds each server's whole guidance once to a single search response", async () => {
    const { tool } = setup();
    const result = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("guidance-search", {
      query: "court decisions",
      limit: 4,
    });
    const [list = "", guidance = ""] = result.content.map((part) =>
      part.type === "text" ? part.text : "",
    );
    const details = result.details as Array<{ id: string }>;

    // The result list keeps its shape; guidance follows as its own wrapped block.
    expect(result.content).toHaveLength(2);
    expect(details.map((candidate) => candidate.id).toSorted()).toEqual([
      "mcp:calc:calc__run",
      "mcp:plain:plain__ping",
      "mcp:research:research__fetch",
      "mcp:research:research__search",
    ]);
    expect(list).not.toContain("GUIDANCE");
    // One copy per server, keyed by server, never repeated per candidate.
    expect(occurrences(guidance, "RESEARCH_GUIDANCE")).toBe(1);
    expect(occurrences(guidance, "RESEARCH_TAIL: on monthly_quota_exceeded, never retry.")).toBe(1);
    expect(occurrences(guidance, calcGuidance)).toBe(1);
    expect(guidance).toContain('"mcpServerInstructions"');
    expect(guidance).toContain("EXTERNAL_UNTRUSTED_CONTENT");

    // Discovery owns delivery; calling a tool returns only its invocation result.
    const dispatched = await tool(TOOL_CALL_RAW_TOOL_NAME).execute("guidance-dispatch", {
      id: "research__search",
      args: {},
    });
    expect(modelText(dispatched)).not.toContain("mcpServerInstructions");
  });

  it.each([
    { label: "16k ASCII", context: 64_000, body: "x".repeat(18_000), whole: false },
    { label: "unknown context", context: undefined, body: "x".repeat(18_000), whole: false },
    { label: "weighted CJK", context: 64_000, body: "界".repeat(5_000), whole: false },
    { label: "32k ASCII", context: 128_000, body: "x".repeat(18_000), whole: true },
  ])(
    "keeps whole guidance or an accurate marker through the live guard: $label",
    async ({ context, body, whole }) => {
      const tail = "REQUIRE_HUMAN_CONFIRMATION_BEFORE_WRITING";
      const guidance = "SERVER_GUIDANCE " + body + " " + tail;
      const { tool } = setup({ researchGuidance: guidance, modelContextWindowTokens: context });
      const results = [
        await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("guard-search", {
          query: "research__search",
          limit: 1,
        }),
        await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("guard-batch", {
          queries: [{ query: "research__search", limit: 1 }],
        }),
        await tool(TOOL_DESCRIBE_RAW_TOOL_NAME).execute("guard-describe", {
          id: "research__search",
        }),
      ];
      for (const [index, result] of results.entries()) {
        const message = {
          role: "toolResult" as const,
          toolCallId: "guard",
          toolName: "tool_search",
          content: result.content,
          isError: false,
          timestamp: 1,
        };
        const guarded = truncateToolResultMessage(
          message,
          resolveAutoLiveToolResultMaxChars(context ?? Number.NaN),
        );
        // The real persistence guard must not cut text admitted by the discovery producer.
        expect(guarded).toBe(message);
        const text = modelText(guarded);
        expect(text.includes(tail)).toBe(whole && index !== 1);
        if (!whole) {
          expect(text).toContain(JSON.stringify(MCP_SERVER_INSTRUCTIONS_TOO_LARGE));
          expect(text).not.toContain("returns the whole text");
          expect(text).not.toContain("SERVER_GUIDANCE");
        } else if (index === 1) {
          expect(text).toContain(
            JSON.stringify(mcpServerInstructionsDescribeMarker("mcp:research:research__search")),
          );
        }
      }
    },
  );

  it("reserves both separately wrapped blocks for single-search guidance", async () => {
    const guidance = "OVERHEAD_GUIDANCE " + "x".repeat(15_000) + " OVERHEAD_TAIL";
    const { tool } = setup({ researchGuidance: guidance, modelContextWindowTokens: 64_000 });
    const result = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("overhead", {
      query: "court decisions",
      limit: 4,
    });
    const message = {
      role: "toolResult" as const,
      toolCallId: "overhead",
      toolName: "tool_search",
      content: result.content,
      isError: false,
      timestamp: 1,
    };
    expect(truncateToolResultMessage(message, 16_000)).toBe(message);
    expect(modelText(result)).not.toContain("OVERHEAD_GUIDANCE");
    const described = await tool(TOOL_DESCRIBE_RAW_TOOL_NAME).execute("overhead-describe", {
      id: "research__search",
    });
    expect(described.details).toMatchObject({ mcpServerInstructions: { research: guidance } });
    expect(modelText(described)).toContain("OVERHEAD_TAIL");
  });

  it.each(["search", "describe"] as const)(
    "preserves an omission notice through the live guard when %s metadata fills the budget",
    async (surface) => {
      const { tool } = setup({
        researchDescription: surface === "search" ? "metadata ".repeat(3_000) : undefined,
        researchParameters: {
          type: "object",
          properties: { query: { type: "string", description: "schema ".repeat(4_000) } },
        },
        modelContextWindowTokens: 64_000,
      });
      const result = await tool(
        surface === "search" ? TOOL_SEARCH_RAW_TOOL_NAME : TOOL_DESCRIBE_RAW_TOOL_NAME,
      ).execute(
        "oversized-metadata",
        surface === "search" ? { query: "research__search", limit: 1 } : { id: "research__search" },
      );
      const guarded = truncateToolResultMessage(
        {
          role: "toolResult",
          toolCallId: "oversized-metadata",
          toolName: surface,
          content: result.content,
          isError: false,
          timestamp: 1,
        },
        16_000,
      );
      expect(modelText(guarded)).toContain("MCP server instructions were omitted");
      expect(modelText(guarded)).toContain("EXTERNAL_UNTRUSTED_CONTENT");
      expect(modelText(guarded)).not.toContain("RESEARCH_GUIDANCE");
      if (surface === "search") {
        expect(Array.isArray(result.details)).toBe(true);
      } else {
        expect(result.details).toMatchObject({ id: "mcp:research:research__search" });
      }
    },
  );

  it("does not rule out every discovery response because one schema cannot carry guidance", async () => {
    const guidance = "SCHEMA_GUIDANCE " + "x".repeat(10_000) + " SCHEMA_TAIL";
    const { tool } = setup({
      researchGuidance: guidance,
      modelContextWindowTokens: 64_000,
      researchParameters: {
        type: "object",
        properties: { query: { type: "string", description: "s".repeat(10_000) } },
      },
    });
    const batch = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("large-schema-batch", {
      queries: [{ query: "research__search", limit: 1 }],
    });
    expect(modelText(batch)).not.toContain("including tool_describe");
    expect(modelText(batch)).not.toContain("SCHEMA_GUIDANCE");
    const single = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("large-schema-single", {
      query: "research__search",
      limit: 1,
    });
    expect(modelText(single)).toContain("SCHEMA_TAIL");
    const smallSchema = await tool(TOOL_DESCRIBE_RAW_TOOL_NAME).execute("small-schema", {
      id: "research__fetch",
    });
    expect(modelText(smallSchema)).toContain("SCHEMA_TAIL");
  });

  it("adds no guidance block when no returned server publishes guidance", async () => {
    const { tool } = setup();
    const result = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("plain-search", {
      query: "plain__ping",
      limit: 1,
    });
    expect(result.details).toEqual([expect.objectContaining({ id: "mcp:plain:plain__ping" })]);
    expect(result.content).toHaveLength(1);
  });

  it("keeps a batch within its budget and points to tool_describe for guidance that fits there", async () => {
    const guidance = `MID_GUIDANCE ${"y".repeat(10_000)} MID_TAIL`;
    const { tool } = setup({ researchGuidance: guidance });
    const result = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("mid-batch", {
      queries: [
        { query: "research__search", limit: 1 },
        { query: "research__fetch", limit: 1 },
        { query: "calc__run", limit: 1 },
      ],
    });
    const details = result.details as {
      results: Array<{ candidates: Array<{ id: string }>; truncated?: true }>;
      truncated?: true;
      mcpServerInstructions: Record<string, string>;
    };
    const text = modelText(result);

    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS);
    expect(details.truncated).toBeUndefined();
    expect(details.results.map((group) => group.candidates.map((entry) => entry.id))).toEqual([
      ["mcp:research:research__search"],
      ["mcp:research:research__fetch"],
      ["mcp:calc:calc__run"],
    ]);
    // Whole text or an accurate marker, never a prefix of the server's text.
    expect(details.mcpServerInstructions).toEqual({
      research: mcpServerInstructionsDescribeMarker("mcp:research:research__search"),
      calc: calcGuidance,
    });
    expect(text).not.toContain("MID_GUIDANCE");

    const described = await tool(TOOL_DESCRIBE_RAW_TOOL_NAME).execute("mid-describe", {
      id: "mcp:research:research__search",
    });
    expect(described.details).toMatchObject({ mcpServerInstructions: { research: guidance } });
    expect(occurrences(modelText(described), "MID_TAIL")).toBe(1);
  });

  it("bounds every batch size and reports guidance that cannot fit even as a marker", async () => {
    const guidance = `MID_GUIDANCE ${"y".repeat(10_000)} MID_TAIL`;
    const { tool } = setup({ researchGuidance: guidance });
    for (let count = 1; count <= 16; count++) {
      const result = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute(`sized-batch-${count}`, {
        queries: Array.from({ length: count }, (_, index) => ({
          query: index % 2 === 0 ? "court decisions" : "research__fetch",
          limit: 3,
        })),
      });
      const details = result.details as {
        results: Array<{ candidates: Array<{ id: string }> }>;
        truncated?: true;
        mcpServerInstructions?: Record<string, string>;
      };
      expect(modelText(result).length).toBeLessThanOrEqual(MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS);
      const servers = new Set(
        details.results.flatMap((group) =>
          group.candidates
            .map((candidate) => candidate.id.split(":")[1])
            .filter((server) => server === "research" || server === "calc"),
        ),
      );
      for (const server of servers) {
        // Every guided server gets its text or a marker, or the batch reports truncation.
        expect(
          details.mcpServerInstructions?.[server] !== undefined || details.truncated === true,
        ).toBe(true);
      }
      expect(modelText(result)).not.toContain("MID_GUIDANCE");
    }
  });

  it("never promises tool_describe for guidance longer than any response can carry", async () => {
    const oversized = `OVERSIZED_GUIDANCE ${"x".repeat(25_000)} OVERSIZED_TAIL`;
    const { tool } = setup({ researchGuidance: oversized });
    const search = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("oversized-search", {
      query: "research__search",
      limit: 1,
    });
    const batch = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("oversized-batch", {
      queries: [
        { query: "research__search", limit: 1 },
        { query: "calc__run", limit: 1 },
      ],
    });
    const described = await tool(TOOL_DESCRIBE_RAW_TOOL_NAME).execute("oversized-describe", {
      id: "mcp:research:research__search",
    });

    for (const result of [search, batch, described]) {
      const text = modelText(result);
      expect(text).toContain(JSON.stringify(MCP_SERVER_INSTRUCTIONS_TOO_LARGE));
      expect(text).not.toContain("OVERSIZED_GUIDANCE");
      expect(text).not.toContain("returns the whole text");
      expect(text).not.toContain("[truncated]");
    }
    expect(batch.details).toMatchObject({
      results: [
        { candidates: [{ id: "mcp:research:research__search" }] },
        { candidates: [{ id: "mcp:calc:calc__run" }] },
      ],
      mcpServerInstructions: { calc: calcGuidance },
    });
    expect(modelText(batch).length).toBeLessThanOrEqual(MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS);
  });
});
