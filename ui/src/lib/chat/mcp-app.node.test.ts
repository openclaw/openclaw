import { describe, expect, it } from "vitest";
import {
  buildMcpAppResourceUrl,
  buildMcpAppSandboxUrl,
} from "../../pages/chat/components/mcp-app-frame.ts";
import { extractMcpAppPreview, resolveMcpAppPreviewPayload } from "./mcp-app.ts";
import { extractToolCards } from "./tool-cards.ts";

const appDetails = {
  mcpApp: {
    viewId: "mcpview_0123456789ABCDEFGHJKMNPQRSTVWXYZ",
    serverName: "diagrams",
    toolName: "create_view",
    resourceUri: "ui://diagrams/app.html",
  },
};

describe("extractMcpAppPreview", () => {
  it("builds an mcp-app preview from tool details", () => {
    const preview = extractMcpAppPreview(appDetails, { elements: "[]" });
    expect(preview).toMatchObject({
      kind: "mcp-app",
      serverName: "diagrams",
      title: "create_view",
      viewId: "mcpview_0123456789ABCDEFGHJKMNPQRSTVWXYZ",
      resourceUri: "ui://diagrams/app.html",
    });
  });

  it("returns undefined without a valid opaque view id", () => {
    expect(extractMcpAppPreview(undefined)).toBe(undefined);
    expect(extractMcpAppPreview({})).toBe(undefined);
    expect(extractMcpAppPreview({ mcpApp: { viewId: "guessable" } })).toBe(undefined);
  });
});

describe("resolveMcpAppPreviewPayload", () => {
  it("hydrates a descriptor from the bounded Gateway resource payload", () => {
    const preview = extractMcpAppPreview(appDetails)!;
    expect(
      resolveMcpAppPreviewPayload(preview, {
        serverName: "diagrams",
        toolName: "create_view",
        resource: {
          uri: "ui://diagrams/app.html",
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
      }),
    ).toMatchObject({
      html: expect.stringContaining("app"),
      csp: { connectDomains: ["https://esm.sh"] },
      permissions: ["clipboardWrite"],
      prefersBorder: true,
      toolInput: { elements: "[persisted]" },
      toolResult: {
        content: [{ type: "text", text: "rendered" }],
        structuredContent: { elements: [] },
        _meta: { source: "server" },
      },
    });
  });

  it("rejects a resource that does not match the descriptor", () => {
    const preview = extractMcpAppPreview(appDetails)!;
    expect(
      resolveMcpAppPreviewPayload(preview, {
        serverName: "other",
        resource: { uri: "ui://diagrams/app.html", html: "<html></html>" },
        result: {},
      }),
    ).toBeUndefined();
  });
});

describe("buildMcpAppSandboxUrl", () => {
  it("builds a ticketed resource URL without embedding app data", () => {
    const url = new URL(
      buildMcpAppResourceUrl({
        basePath: "/openclaw",
        ticket: "signed.ticket",
        viewId: "mcpview_0123456789ABCDEFGHJKMNPQRSTVWXYZ",
      }),
      "https://gateway.example",
    );
    expect(url.pathname).toBe("/openclaw/__openclaw__/mcp-app-resource");
    expect(url.searchParams.get("ticket")).toBe("signed.ticket");
    expect(url.searchParams.get("viewId")).toBe("mcpview_0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  });

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
