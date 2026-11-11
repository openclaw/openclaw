import { describe, expect, it, vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  captureMcpAppContext,
  publishMcpAppContext,
  readMcpAppContexts,
  subscribeMcpAppContexts,
  mcpAppContextItemTitle,
  mcpAppContextThumbnail,
} from "./mcp-app-context.ts";

describe("app context presentation", () => {
  it("replaces one app without merging old context or crossing conversation/connection ownership", () => {
    const client = {} as NonNullable<ApplicationGateway["snapshot"]["client"]>;
    const otherClient = {} as NonNullable<ApplicationGateway["snapshot"]["client"]>;
    const notify = vi.fn();
    const stop = subscribeMcpAppContexts(client, notify);
    const entry = {
      sessionKey: "agent:main:one",
      agentId: "main",
      viewId: "a",
      title: "Parts",
      state: { updateId: "1", content: [{ type: "text" as const, text: "old" }] },
    };
    publishMcpAppContext(client, entry);
    publishMcpAppContext(client, { ...entry, viewId: "b" });
    publishMcpAppContext(client, {
      ...entry,
      state: { updateId: "2", content: [{ type: "text", text: "new" }] },
    });
    expect(
      readMcpAppContexts(client, entry.sessionKey, "main").map((item) => item.state?.content?.[0]),
    ).toEqual([
      { type: "text", text: "new" },
      { type: "text", text: "old" },
    ]);
    expect(readMcpAppContexts(client, "agent:main:two", "main")).toEqual([]);
    expect(readMcpAppContexts(otherClient, entry.sessionKey, "main")).toEqual([]);
    publishMcpAppContext(client, { ...entry, state: null });
    expect(readMcpAppContexts(client, entry.sessionKey, "main").map((item) => item.viewId)).toEqual(
      ["b"],
    );
    expect(notify).toHaveBeenCalledTimes(4);
    stop();
  });
  it("uses authored titles and only inline raster previews", () => {
    expect(
      mcpAppContextItemTitle(
        { type: "text", text: "private payload", _meta: { "openai/title": "Selected bolts" } },
        "App",
      ),
    ).toBe("Selected bolts");
    expect(
      mcpAppContextThumbnail({ type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" }),
    ).toBeNull();
    expect(mcpAppContextThumbnail({ type: "image", mimeType: "image/png", data: "YWJj" })).toBe(
      "data:image/png;base64,YWJj",
    );
  });
});

it("uses safe MCP resource icons and freezes submitted references", () => {
  const content = {
    type: "resource_link" as const,
    name: "helmet.json",
    title: "Helmet shell",
    uri: "shell://specimens/helmet",
    description: "Helmet facts",
    icons: [{ src: "https://example.test/shell.png" }],
  };
  expect(mcpAppContextThumbnail(content)).toBe("https://example.test/shell.png");
  const entry = {
    viewId: "v",
    title: "Store",
    sessionKey: "main",
    state: { updateId: "1", content: [content] },
  };
  // SAFETY: Context projections key by client identity without invoking the client.
  const client = {} as NonNullable<ApplicationGateway["snapshot"]["client"]>;
  publishMcpAppContext(client, entry);
  const snapshot = captureMcpAppContext(client, entry.sessionKey);
  content.title = "Changed selection";
  expect(snapshot).toEqual([
    {
      title: "Helmet shell",
      uri: content.uri,
      description: "Helmet facts",
      icon: "https://example.test/shell.png",
    },
  ]);
  expect(
    mcpAppContextThumbnail({ ...content, icons: [{ src: "javascript:alert(1)" }] }),
  ).toBeNull();
});

it("keeps the visible App title when only structured context is shared", () => {
  // SAFETY: Context projections key by client identity without invoking the client.
  const client = {} as NonNullable<ApplicationGateway["snapshot"]["client"]>;
  publishMcpAppContext(client, {
    viewId: "structured",
    title: "Specimen comparison",
    sessionKey: "main",
    state: { updateId: "1", structuredContent: { specimen: "Helmet shell" } },
  });
  expect(captureMcpAppContext(client, "main")).toEqual([{ title: "Specimen comparison" }]);
});
