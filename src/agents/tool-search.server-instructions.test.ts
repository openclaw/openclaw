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
    const details = result.details as {
      results: Array<{ id: string; mcp?: Record<string, unknown> }>;
      mcpServerInstructions: Record<string, string>;
    };
    const text = modelText(result);

    expect(details.results.map((candidate) => candidate.id).toSorted()).toEqual([
      "mcp:calc:calc__run",
      "mcp:plain:plain__ping",
      "mcp:research:research__fetch",
      "mcp:research:research__search",
    ]);
    // One copy per server, keyed by server, never repeated per candidate.
    expect(details.mcpServerInstructions).toEqual({
      research: researchGuidance,
      calc: calcGuidance,
    });
    expect(JSON.stringify(details.results)).not.toContain("GUIDANCE");
    expect(researchGuidance.length).toBeGreaterThan(3_000);
    expect(occurrences(text, "RESEARCH_GUIDANCE")).toBe(1);
    expect(occurrences(text, "RESEARCH_TAIL: on monthly_quota_exceeded, never retry.")).toBe(1);
    expect(occurrences(text, calcGuidance)).toBe(1);
    expect(text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    // Callable entries come first; guidance follows them.
    expect(text.indexOf("mcp:research:research__search")).toBeLessThan(
      text.indexOf("RESEARCH_GUIDANCE"),
    );
  });

  it("keeps the plain result list when no returned server publishes guidance", async () => {
    const { tool } = setup();
    const result = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("plain-search", {
      query: "plain__ping",
      limit: 1,
    });
    expect(result.details).toEqual([expect.objectContaining({ id: "mcp:plain:plain__ping" })]);
  });

  it("adds whole guidance once per server to a batch response that has room", async () => {
    const shortGuidance =
      "RESEARCH_GUIDANCE: rank binding precedents first.\nRESEARCH_TAIL: never retry.";
    const { tool } = setup({ researchGuidance: shortGuidance });
    const result = await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("guidance-batch", {
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

    expect(details.results.map((group) => group.candidates.map((entry) => entry.id))).toEqual([
      ["mcp:research:research__search"],
      ["mcp:research:research__fetch"],
      ["mcp:calc:calc__run"],
    ]);
    expect(details.truncated).toBeUndefined();
    expect(details.mcpServerInstructions).toEqual({ research: shortGuidance, calc: calcGuidance });
    expect(occurrences(text, "RESEARCH_TAIL: never retry.")).toBe(1);
    expect(occurrences(text, calcGuidance)).toBe(1);
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS);
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
      expect(result.details).toMatchObject({
        mcpServerInstructions: { research: MCP_SERVER_INSTRUCTIONS_TOO_LARGE },
      });
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

  it("adds the whole guidance after the schema in tool_describe", async () => {
    const { tool } = setup();
    const result = await tool(TOOL_DESCRIBE_RAW_TOOL_NAME).execute("guidance-describe", {
      id: "mcp:research:research__fetch",
    });
    const text = modelText(result);

    expect(result.details).toMatchObject({
      id: "mcp:research:research__fetch",
      parameters: { type: "object" },
      mcpServerInstructions: { research: researchGuidance },
    });
    expect(occurrences(text, "RESEARCH_TAIL: on monthly_quota_exceeded, never retry.")).toBe(1);
    expect(text.indexOf('"parameters"')).toBeLessThan(text.indexOf("RESEARCH_GUIDANCE"));
  });

  it("adds guidance to the first dispatch that reaches a server without discovery", async () => {
    const { tool } = setup();
    const dispatch = tool(TOOL_CALL_RAW_TOOL_NAME);
    const first = modelText(
      await dispatch.execute("dispatch-1", { id: "research__search", args: { q: "x" } }),
    );
    const second = modelText(
      await dispatch.execute("dispatch-2", { id: "research__fetch", args: { id: "1" } }),
    );
    const otherServer = modelText(await dispatch.execute("dispatch-3", { id: "calc__run" }));

    expect(occurrences(first, "RESEARCH_TAIL: on monthly_quota_exceeded, never retry.")).toBe(1);
    expect(first.indexOf('"result"')).toBeLessThan(first.indexOf("RESEARCH_GUIDANCE"));
    expect(second).not.toContain("RESEARCH_GUIDANCE");
    expect(otherServer).toContain(calcGuidance);
  });

  it("does not repeat guidance in dispatch after a discovery response delivered it", async () => {
    const { tool } = setup();
    await tool(TOOL_SEARCH_RAW_TOOL_NAME).execute("search-first", {
      query: "research__search",
      limit: 1,
    });
    const dispatched = modelText(
      await tool(TOOL_CALL_RAW_TOOL_NAME).execute("dispatch-after-search", {
        id: "research__search",
        args: {},
      }),
    );
    expect(dispatched).not.toContain("RESEARCH_GUIDANCE");
    expect(dispatched).toContain("mcp:research:research__search");
  });
});
