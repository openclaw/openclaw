import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { mcpTool } from "./code-mode.test-support.js";
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

function setup(options: { researchGuidance?: string } = {}) {
  const catalogRef = createToolSearchCatalogRef();
  const guidance = options.researchGuidance ?? researchGuidance;
  registerHeadlessToolSearchCatalog({
    catalogRef,
    tools: [
      mcpTool({
        name: "research__search",
        serverName: "research",
        toolName: "search",
        description: "Search court decisions by topic.",
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
  const tools = createToolSearchTools({ catalogRef, config: { tools: { toolSearch: true } } });
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
