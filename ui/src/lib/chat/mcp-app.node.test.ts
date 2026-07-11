import { describe, expect, it } from "vitest";
import { buildMcpAppSandboxUrl } from "../../pages/chat/components/mcp-app-frame.ts";
import { extractMcpAppPreview } from "./mcp-app.ts";
import { extractToolCards } from "./tool-cards.ts";

const appDetails = {
  mcpApp: {
    serverName: "diagrams",
    toolName: "create_view",
    resource: {
      uri: "ui://diagrams/app.html",
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
      resourceUri: "ui://diagrams/app.html",
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

describe("buildMcpAppSandboxUrl", () => {
  it("preserves the Control UI base path and encodes app CSP metadata", () => {
    const url = new URL(
      buildMcpAppSandboxUrl({
        basePath: "/openclaw",
        ticket: "signed.ticket",
        csp: {
          connectDomains: ["https://api.example.com"],
          resourceDomains: ["https://cdn.example.com"],
        },
      }),
      "https://gateway.example",
    );
    expect(url.pathname).toBe("/openclaw/__openclaw__/mcp-app-sandbox");
    expect(url.searchParams.get("ticket")).toBe("signed.ticket");
    expect(JSON.parse(url.searchParams.get("csp") ?? "{}")).toEqual({
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
    });
  });

  it("drops unsafe and excessive CSP origins before building the iframe URL", () => {
    const url = new URL(
      buildMcpAppSandboxUrl({
        basePath: "",
        ticket: "signed.ticket",
        csp: {
          connectDomains: [
            "https://api.example.com",
            "https://bad.example; script-src *",
            ...Array.from({ length: 40 }, (_, index) => `https://api-${index}.example.com`),
          ],
        },
      }),
      "https://gateway.example",
    );
    const csp = JSON.parse(url.searchParams.get("csp") ?? "{}") as {
      connectDomains?: string[];
    };
    expect(csp.connectDomains).toHaveLength(32);
    expect(csp.connectDomains).toContain("https://api.example.com");
    expect(csp.connectDomains?.some((origin) => origin.includes(";"))).toBe(false);
  });
});

describe("extractToolCards mcp-app preview", () => {
  it("attaches the mcp-app preview to tool result cards", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [
        { type: "toolCall", name: "diagrams_create_view", id: "call-1", arguments: {} },
        {
          type: "toolResult",
          name: "diagrams_create_view",
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
