import { describe, expect, it } from "vitest";
import {
  extractCanvasFromDetails,
  extractCanvasFromText,
  extractCanvasShortcodes,
} from "./canvas-render.ts";

function fromText(payload: Record<string, unknown>) {
  return extractCanvasFromText(JSON.stringify({ kind: "canvas", ...payload }));
}

describe("extractCanvasFromText", () => {
  const statusView = {
    id: "cv_status",
    url: "/__openclaw__/canvas/documents/cv_status/index.html",
  };
  it("preserves a valid pinned board widget identity", () => {
    const preview = fromText({ view: { ...statusView, boardWidgetName: "release-status" } });
    expect(preview).toMatchObject({ viewId: "cv_status", boardWidgetName: "release-status" });
  });

  it("preserves node-panel presentation metadata", () => {
    const preview = fromText({
      presentation: { target: "node_panel", title: "Status" },
      view: statusView,
    });
    expect(preview).toMatchObject({ surface: "node_panel", viewId: "cv_status", title: "Status" });
  });

  it("extracts safe MCP App preview metadata from tool details", () => {
    const mcpApp = {
      viewId: "cv_app",
      serverName: "demo",
      toolName: "show",
      uiResourceUri: "ui://demo/app",
      toolCallId: "call-1",
      originSessionKey: "agent:main:main",
      resultMetaState: "unavailable",
    };
    const preview = extractCanvasFromDetails({
      mcpAppPreview: {
        kind: "canvas",
        view: { id: "cv_app" },
        presentation: { target: "assistant_message", sandbox: "scripts" },
        mcpApp,
      },
    });
    expect(preview).toMatchObject({ viewId: "cv_app", mcpApp });
  });

  it("keeps MCP App previews opaque while preserving model-visible results", () => {
    const mcpApp = { viewId: "cv_app" };
    const preview = fromText({
      view: { id: "cv_app" },
      presentation: { target: "assistant_message", sandbox: "scripts" },
      mcpApp,
      result: [{ type: "text", text: "model-visible result" }],
    });
    expect(preview).toMatchObject({ viewId: "cv_app", sandbox: "scripts", mcpApp });
  });
});

describe("extractCanvasShortcodes", () => {
  it("extracts only selected previews while preserving other embeds and code examples", () => {
    const selected = '[embed ref="cv_owned" /]';
    const other = '[embed ref="cv_other" /]';
    const literal = `\`${selected}\``;
    expect(
      extractCanvasShortcodes(
        `Before ${selected} between ${other} after ${literal}`,
        (preview) => preview.viewId === "cv_owned",
      ),
    ).toMatchObject({
      text: `Before  between ${other} after ${literal}`,
      previews: [{ viewId: "cv_owned" }],
    });
  });

  it("does not let a self-closing embed start a greedy block match", () => {
    const input = '[embed url="https://a.com" /] keep me [/embed]';
    expect(extractCanvasShortcodes(input)).toMatchObject({
      text: " keep me [/embed]",
      previews: [{ url: "https://a.com" }],
    });
  });

  it("preserves literal embed examples in inline code", () => {
    const input =
      'Before the example.\n\n`[embed url="https://example.com/image.png" /]`\n\nAfter the example.';
    expect(extractCanvasShortcodes(input)).toEqual({ text: input, previews: [] });
  });
});

it("removes a shortcode without rewriting surrounding literal whitespace", () => {
  const source = '    a\n\n\n    b\n\n[embed ref="doc1" /]';
  expect(extractCanvasShortcodes(source)).toMatchObject({
    text: "    a\n\n\n    b\n\n",
    previews: [{ viewId: "doc1" }],
  });
});
