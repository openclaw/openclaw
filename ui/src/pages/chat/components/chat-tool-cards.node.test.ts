// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  extractToolCardsCached as extractToolCards,
  isToolCardError,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { resolveCanvasIframeUrl } from "../../../lib/chat/tool-display.ts";

function assistantCards(content: unknown[], metadata: Record<string, unknown> = {}) {
  return extractToolCards({ role: "assistant", content, ...metadata });
}

describe("tool-card extraction", () => {
  const browserTarget = { profile: "managed", target: "host", targetId: "tab-origin" };
  const browserDetails = { browserTab: { ...browserTarget, url: "https://example.com" } };

  it.each([
    ["browser", "read", true],
    ["read", "browser", false],
  ] as const)(
    "uses the paired call origin %s instead of the result name %s",
    (callName, resultName, browserOrigin) => {
      const cards = assistantCards([
        { type: "toolcall", id: "origin-call", name: callName, arguments: {} },
        {
          type: "tool_result",
          tool_use_id: "origin-call",
          name: resultName,
          text: "paired output",
          details: browserDetails,
        },
      ]);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ name: callName, outputText: "paired output" });
      expect(cards[0]?.preview).toEqual(
        browserOrigin ? { kind: "browser-tab", ...browserDetails.browserTab } : undefined,
      );
      expect(cards[0]?.browserTab).toEqual(browserOrigin ? browserTarget : undefined);
    },
  );

  it("does not borrow browser origin from a call with a different ID", () => {
    const cards = assistantCards([
      { type: "toolcall", id: "browser-call", name: "browser", arguments: {} },
      {
        type: "tool_result",
        id: "unknown-call",
        text: "unpaired output",
        details: browserDetails,
      },
    ]);
    expect(cards).toHaveLength(2);
    expect(cards[1]?.outputText).toBe("unpaired output");
    expect(cards[1]?.preview).toBeUndefined();
    expect(cards[1]?.browserTab).toBeUndefined();
  });

  it("does not let nested content claim browser origin inside a non-browser tool envelope", () => {
    const toolName = "browser.open";
    const result = {
      type: "tool_result",
      name: "browser",
      text: "nested output",
      details: browserDetails,
    };
    for (const nameField of ["toolName", "tool_name"]) {
      const [card] = extractToolCards({
        role: "toolResult",
        [nameField]: toolName,
        content: [result],
      });
      expect(card?.name).toBe("browser");
      expect(card?.outputText).toBe("nested output");
      expect(card?.preview).toBeUndefined();
      expect(card?.browserTab).toBeUndefined();
      const [paired] = extractToolCards({
        role: "toolResult",
        [nameField]: toolName,
        content: [
          { type: "toolcall", id: "nested-browser", name: "browser", arguments: {} },
          { ...result, id: "nested-browser", text: "nested paired output" },
        ],
      });
      expect(paired?.outputText).toBe("nested paired output");
      expect(paired?.preview).toBeUndefined();
      expect(paired?.browserTab).toBeUndefined();
    }
  });

  it("retains browser envelope origin from tool_name", () => {
    const nameField = "tool_name";
    const [card] = extractToolCards({
      role: "toolResult",
      [nameField]: "browser",
      content: [{ type: "tool_result", text: "browser output", details: browserDetails }],
    });
    expect(card?.preview).toEqual({ kind: "browser-tab", ...browserDetails.browserTab });
    expect(card?.outputText).toBe("browser output");
  });

  it.each(["standalone", "live"])("extracts browser tabs from %s results", (shape) => {
    const details = {
      browserTab: {
        ...browserDetails.browserTab,
        targetId: "tab-1",
        title: "Example",
        extra: "drop",
      },
    };
    const result = { type: "toolresult", id: "call-browser", name: "browser", text: "ok" };
    const message =
      shape === "standalone"
        ? { role: "toolResult", toolName: "browser", details, content: "ok" }
        : {
            role: "assistant",
            details,
            __openclawToolStreamLive: true,
            __openclawToolStreamResultReceived: true,
            content: [
              { type: "toolcall", id: "call-browser", name: "browser", arguments: {} },
              result,
            ],
          };
    const [card] = extractToolCards(message);
    expect(card?.preview).toEqual({
      kind: "browser-tab",
      ...browserDetails.browserTab,
      targetId: "tab-1",
      title: "Example",
    });
    expect(card?.completed).toBe(true);
  });

  it("keeps routing and raw output without unsafe browser previews", () => {
    const browserTab = { profile: "managed", target: "host", targetId: "tab-1" };
    const url = "javascript:void(0)";
    const details = { browserTab: { ...browserTab, url } };
    const output = JSON.stringify({ url });
    const [card] = extractToolCards({
      role: "toolResult",
      toolName: "browser",
      content: output,
      details,
    });
    expect(card?.outputText).toBe(output);
    expect(card?.details).toEqual(details);
    expect(card?.preview).toBeUndefined();
    expect(card?.browserTab).toEqual(browserTab);
  });

  it.each([
    {},
    { targetId: " " },
    { targetId: "t1" },
    { targetId: "t1", profile: "managed", target: "node" },
    { targetId: "t1", profile: "managed", target: "host", node: "node-a" },
    { targetId: "t".repeat(129), profile: "managed", target: "host" },
  ])("ignores malformed browser tabs (%j)", (browserTab) => {
    const [card] = extractToolCards({ role: "tool", toolName: "browser", details: { browserTab } });
    expect(card?.preview).toBeUndefined();
    expect(card?.browserTab).toBeUndefined();
  });

  it("retains exact bounded node identities without provider metadata", () => {
    const browserTab = {
      targetId: "t".repeat(128),
      profile: "p".repeat(128),
      target: "node",
      node: "n".repeat(256),
    };
    const [card] = extractToolCards({
      role: "toolResult",
      toolName: "browser",
      details: {
        browserTab: {
          ...browserTab,
          cdpUrl: "https://private.example/",
          token: "not-a-real-token",
        },
      },
    });
    expect(card?.browserTab).toEqual(browserTab);
    expect(card?.preview).toBeUndefined();
  });

  it("drops non-string browser metadata and gives canvas previews precedence", () => {
    const browserTab = {
      profile: "managed",
      target: "host",
      targetId: "tab-1",
      url: 42,
      title: [],
    };
    expect(
      extractToolCards({ role: "tool", toolName: "browser", details: { browserTab } })[0]?.preview,
    ).toBeUndefined();
    const canvas = {
      kind: "canvas",
      view: { id: "cv_app" },
      presentation: { target: "assistant_message" },
      mcpApp: { viewId: "cv_app" },
    };
    for (const message of [
      { role: "tool", details: { browserTab, mcpAppPreview: canvas } },
      { role: "tool", toolName: "browser", details: { browserTab, mcpAppPreview: canvas } },
      {
        role: "tool",
        toolName: "canvas_render",
        details: { browserTab },
        content: JSON.stringify(canvas),
      },
    ]) {
      expect(extractToolCards(message)[0]?.preview?.kind).toBe("canvas");
    }
  });

  it.each([
    { name: "bigint", args: 42n, expected: "42" },
    { name: "symbol", args: Symbol("input"), expected: undefined },
    { name: "boxed bigint", args: Object(42n), expected: "[object BigInt]" },
  ])("preserves $name tool input display", ({ args, expected }) => {
    const [card] = assistantCards([
      { type: "toolcall", id: "input-display", name: "example", arguments: args },
    ]);
    expect(card).toBeDefined();
    expect(card?.inputText).toBe(expected);
  });

  it("keeps a same-name result with different legacy call IDs separate from an open call", () => {
    const resultId = { callId: "call-b" };
    const cards = assistantCards([
      { type: "tool_use", id: "call-a", name: "read", input: { path: "a.txt" } },
      { type: "tool_result", ...resultId, name: "read", text: "B failed", isError: true },
    ]);

    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ callId: "call-a", name: "read" });
    expect(cards[0]?.completed).toBeUndefined();
    expect(cards[0]?.outputText).toBeUndefined();
    expect(cards[0]?.isError).toBeUndefined();
    expect(cards[1]).toMatchObject({
      callId: "call-b",
      name: "read",
      completed: true,
      outputText: "B failed",
      isError: true,
    });
  });

  it.each([
    ["only the call owns an ID", { id: "call-a" }, {}],
    ["only the result owns an ID", {}, { tool_use_id: "call-b" }],
  ])("preserves legacy same-name fallback when %s", (_label, callId, resultId) => {
    const cards = assistantCards([
      { type: "tool_use", ...callId, name: "read", input: { path: "legacy.txt" } },
      { type: "tool_result", ...resultId, name: "read", text: "Legacy contents" },
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      name: "read",
      completed: true,
      outputText: "Legacy contents",
    });
  });

  it("does not reuse nameless same-name calls after an empty result", () => {
    const cards = assistantCards([
      { type: "tool_use", name: "read", input: { path: "empty.txt" } },
      { type: "tool_use", name: "read", input: { path: "next.txt" } },
      { type: "tool_result", name: "read", text: "" },
      { type: "tool_result", name: "read", text: "Next contents" },
    ]);

    expect(cards).toHaveLength(2);
    expect(cards[0]?.inputText).toBe('{\n  "path": "empty.txt"\n}');
    expect(cards[0]?.completed).toBe(true);
    expect(cards[0]?.outputText).toBe("");
    expect(cards[1]?.inputText).toBe('{\n  "path": "next.txt"\n}');
    expect(cards[1]?.outputText).toBe("Next contents");
  });

  it("extracts tool result output from text block content arrays", () => {
    const cards = assistantCards([
      { type: "toolcall", id: "call-read", name: "read", input: { path: "README.md" } },
      {
        type: "tool_result",
        id: "call-read",
        name: "read",
        content: [
          { type: "text", text: "# Heading" },
          { type: "text", text: "file body" },
        ],
      },
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.outputText).toBe("# Heading\nfile body");
  });
});

describe("tool-card canvas URLs", () => {
  it("accepts hosted canvas paths and scopes them through the canvas capability host", () => {
    const entry = "/__openclaw__/canvas/documents/cv_demo/index.html";
    const host = "http://127.0.0.1:19003/__openclaw__/cap/cap_123";
    expect(resolveCanvasIframeUrl(entry)).toBe(entry);
    expect(resolveCanvasIframeUrl(entry, host)).toBe(`${host}${entry}`);
  });

  it("rejects unsafe canvas frame URLs unless external embeds are explicitly enabled", () => {
    expect(resolveCanvasIframeUrl("/not-canvas/snake.html")).toBeUndefined();
    expect(resolveCanvasIframeUrl("https://example.com/evil.html")).toBeUndefined();
    expect(resolveCanvasIframeUrl("file:///tmp/snake.html", undefined, true)).toBeUndefined();
    expect(resolveCanvasIframeUrl("https://example.com/embed.html?x=1#y", undefined, true)).toBe(
      "https://example.com/embed.html?x=1#y",
    );
  });
});

describe("tool card outcomes", () => {
  it("keeps error-shaped partial output nonterminal until the live result arrives", () => {
    const text = '{"error": "partial text"}';
    // Update blocks cannot settle a live tool before resultReceived.
    const stream = (output: string, received: boolean) =>
      assistantCards(
        [
          { type: "toolcall", name: "bash", arguments: { command: "sleep 5" } },
          { type: "toolresult", name: "bash", text: output },
        ],
        {
          toolCallId: "call-live",
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: received,
        },
      );
    const partial = stream(text, false);
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ live: true, completed: false });
    expect(partial[0]?.outputText).toBe(text);
    expect(partial.map(isToolCardError)).toEqual([false]);
    expect(partial.map((card) => resolveToolCardOutcome(card, true))).toEqual(["running"]);
    expect(partial.map((card) => resolveToolCardOutcome(card, false))).toEqual(["unknown"]);

    const done = stream("ok", true);
    expect(done[0]).toMatchObject({ live: true, completed: true });
    expect(done.map((card) => resolveToolCardOutcome(card, true))).toEqual(["succeeded"]);
  });

  it("distinguishes active and terminal calls when history has no outcome", () => {
    const [card] = assistantCards(
      [{ type: "toolcall", id: "call-live", name: "bash", arguments: { command: "sleep 5" } }],
      {
        activity: [
          {
            itemId: "tool:call-live",
            toolCallId: "call-live",
            kind: "tool",
            name: "bash",
            phase: "end",
            title: "Command — outcome unknown",
          },
        ],
        __openclawToolStreamLive: true,
        __openclawToolStreamResultReceived: false,
      },
    );
    expect(card?.activity?.status).toBeUndefined();
    expect(resolveToolCardOutcome(card!, true)).toBe("running");

    const [terminal] = assistantCards(
      [
        { type: "toolcall", id: "call-done", name: "bash", arguments: { command: "echo ok" } },
        { type: "toolresult", id: "call-done", name: "bash", text: "ok" },
      ],
      {
        activity: [
          {
            itemId: "tool:call-done",
            toolCallId: "call-done",
            kind: "tool",
            name: "bash",
            phase: "end",
            title: "Command — outcome unknown",
            summary: "Outcome unknown",
          },
        ],
      },
    );
    expect(terminal).toMatchObject({ completed: true, outputText: "ok" });
    expect(terminal?.activity?.status).toBeUndefined();
    expect(resolveToolCardOutcome(terminal!, false)).toBe("unknown");
  });
});
