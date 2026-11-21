import { expect, it } from "vitest";
import {
  extractCanvasFromDetails,
  extractCanvasFromText,
  extractCanvasShortcodes,
} from "./canvas-render.ts";

const fromText = (payload: Record<string, unknown>) =>
  extractCanvasFromText(JSON.stringify({ kind: "canvas", ...payload }));
const appPreview = (mcpApp: Record<string, unknown>) => ({
  kind: "canvas",
  view: { id: "cv_app" },
  presentation: { target: "assistant_message", sandbox: "scripts" },
  mcpApp,
});

const statusView = { id: "cv_status", url: "/__openclaw__/canvas/documents/cv_status/index.html" };
it("preserves a valid pinned board widget identity", () => {
  expect(fromText({ view: { ...statusView, boardWidgetName: "release-status" } })).toMatchObject({
    viewId: "cv_status",
    boardWidgetName: "release-status",
  });
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
  expect(extractCanvasFromDetails({ mcpAppPreview: appPreview(mcpApp) })).toMatchObject({
    viewId: "cv_app",
    mcpApp,
  });
});

it("keeps MCP App previews opaque while preserving model-visible results", () => {
  const mcpApp = { viewId: "cv_app" };
  const preview = fromText({
    ...appPreview(mcpApp),
    result: [{ type: "text", text: "model-visible result" }],
  });
  expect(preview).toMatchObject({ viewId: "cv_app", sandbox: "scripts", mcpApp });
});

it("extracts only selected previews while preserving other embeds and code examples", () => {
  const selected = '[embed ref="cv_owned" /]';
  const other = '[embed ref="cv_other" /]';
  const literal = `\`${selected}\``;
  const input = `Before ${selected} between ${other} after ${literal}`;
  expect(extractCanvasShortcodes(input, (preview) => preview.viewId === "cv_owned")).toMatchObject({
    text: `Before  between ${other} after ${literal}`,
    previews: [{ viewId: "cv_owned" }],
  });
});

it("strips only the self-closing embed, preserving whitespace and a stray closing tag", () => {
  const input = '    a\n\n\n    b\n\n[embed url="https://a.com" /] keep me [/embed]';
  expect(extractCanvasShortcodes(input)).toMatchObject({
    text: "    a\n\n\n    b\n\n keep me [/embed]",
    previews: [{ url: "https://a.com" }],
  });
});

it("preserves literal embed examples in inline code", () => {
  const input = 'Before.\n\n`[embed url="https://example.com/image.png" /]`\n\nAfter.';
  expect(extractCanvasShortcodes(input)).toEqual({ text: input, previews: [] });
});
