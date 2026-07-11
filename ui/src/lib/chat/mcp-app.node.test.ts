import { describe, expect, it } from "vitest";
import { extractMcpAppPreview } from "./mcp-app.ts";
import { extractToolCards } from "./tool-cards.ts";

const appDetails = {
  mcpApp: {
    serverName: "excalidraw",
    toolName: "create_view",
    resource: {
      uri: "ui://excalidraw/mcp-app.html",
      mimeType: "text/html;profile=mcp-app",
      html: "<!doctype html><html><body>app</body></html>",
      csp: { connectDomains: ["https://esm.sh"] },
      permissions: ["clipboardWrite"],
      prefersBorder: true,
    },
    toolInput: { elements: "[persisted]" },
    result: {
      content: [{ type: "text", text: "rendered" }],
      structuredContent: { elements: [] },
      _meta: { source: "server" },
    },
  },
};

describe("extractMcpAppPreview", () => {
  it("builds an mcp-app preview from tool details", () => {
    const preview = extractMcpAppPreview(appDetails, { elements: "[]" });
    expect(preview).toMatchObject({
      kind: "mcp-app",
      title: "create_view",
      resourceUri: "ui://excalidraw/mcp-app.html",
      csp: { connectDomains: ["https://esm.sh"] },
      permissions: ["clipboardWrite"],
      prefersBorder: true,
      // Persisted details input wins over call-site args so history reloads
      // (where call and result are separate messages) keep the app input.
      toolInput: { elements: "[persisted]" },
      toolResult: {
        content: [{ type: "text", text: "rendered" }],
        structuredContent: { elements: [] },
        _meta: { source: "server" },
      },
    });
    expect(preview?.html).toContain("app");
  });

  it("falls back to call-site args when details carry no input", () => {
    const details = structuredClone(appDetails) as { mcpApp: Record<string, unknown> };
    delete details.mcpApp.toolInput;
    expect(extractMcpAppPreview(details, { elements: "[caller]" })?.toolInput).toEqual({
      elements: "[caller]",
    });
  });

  it("returns undefined without an html document", () => {
    expect(extractMcpAppPreview(undefined)).toBe(undefined);
    expect(extractMcpAppPreview({})).toBe(undefined);
    expect(extractMcpAppPreview({ mcpApp: { resource: { html: "" } } })).toBe(undefined);
  });
});

describe("extractToolCards mcp-app preview", () => {
  it("attaches the mcp-app preview to tool result cards", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [
        { type: "toolCall", name: "excalidraw_create_view", id: "call-1", arguments: {} },
        {
          type: "toolResult",
          name: "excalidraw_create_view",
          toolCallId: "call-1",
          content: [{ type: "text", text: "rendered" }],
          details: appDetails,
        },
      ],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.preview?.kind).toBe("mcp-app");
  });

  it("keeps canvas preview extraction when no app details exist", () => {
    const cards = extractToolCards({
      role: "tool",
      toolName: "read",
      content: [{ type: "toolResult", text: "plain output" }],
    });
    expect(cards[0]?.preview).toBe(undefined);
  });
});
