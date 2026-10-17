// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import {
  extractToolCardsCached as extractToolCards,
  isToolCardError,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { resolveCanvasIframeUrl } from "../../../lib/chat/tool-display.ts";

function assistantCards(content: unknown[], metadata: Record<string, unknown> = {}) {
  return extractToolCards({ role: "assistant", content, ...metadata });
}

function expectNoBrowser(card: ToolCard | undefined) {
  expect([card?.preview, card?.browserTab]).toEqual([undefined, undefined]);
}

const browserCard = (browserTab: unknown, fields: Record<string, unknown> = {}) =>
  extractToolCards({
    role: "toolResult",
    toolName: "browser",
    details: { browserTab },
    ...fields,
  })[0];

function activity(toolCallId: string, phase: "start" | "end", summary?: string) {
  return {
    itemId: `tool:${toolCallId}`,
    toolCallId,
    kind: "tool",
    name: "bash",
    phase,
    title: "Command — outcome unknown",
    ...(summary ? { summary } : {}),
  };
}

describe("tool-card extraction", () => {
  const browserTarget = { profile: "managed", target: "host", targetId: "tab-origin" };
  const browserDetails = { browserTab: { ...browserTarget, url: "https://example.com" } };

  it.each([
    ["browser", "read", true],
    ["read", "browser", true],
    ["browser", undefined, false],
  ] as const)(
    "uses only a paired call origin: call=%s result=%s paired=%s",
    (callName, resultName, paired) => {
      const output = "Tool output";
      const cards = assistantCards([
        { type: "toolcall", id: "origin", name: callName },
        {
          type: "tool_result",
          [paired ? "tool_use_id" : "id"]: paired ? "origin" : "unpaired",
          name: resultName,
          text: output,
          details: browserDetails,
        },
      ]);
      expect(cards).toHaveLength(paired ? 1 : 2);
      const card = cards.at(-1);
      if (paired) {
        expect(card?.name).toBe(callName);
      }
      expect(card?.outputText).toBe(output);
      const browserOrigin = paired && callName === "browser";
      expect(card?.preview).toEqual(
        browserOrigin ? { kind: "browser-tab", ...browserDetails.browserTab } : undefined,
      );
      expect(card?.browserTab).toEqual(browserOrigin ? browserTarget : undefined);
    },
  );

  it("does not let nested content claim browser origin inside a non-browser tool envelope", () => {
    for (const nameField of ["toolName", "tool_name"]) {
      for (const paired of [false, true]) {
        const output = paired ? "nested paired output" : "nested output";
        const [card] = extractToolCards({
          role: "toolResult",
          [nameField]: "browser.open",
          content: [
            ...(paired ? [{ type: "toolcall", id: "nested", name: "browser" }] : []),
            {
              type: "tool_result",
              name: "browser",
              id: paired ? "nested" : undefined,
              text: output,
              details: browserDetails,
            },
          ],
        });
        expect(card).toMatchObject({ name: "browser", outputText: output });
        expectNoBrowser(card);
      }
    }
  });

  it("retains browser envelope origin from tool_name", () => {
    const [card] = extractToolCards({
      role: "toolResult",
      tool_name: "browser",
      content: [{ type: "tool_result", text: "browser output", details: browserDetails }],
    });
    expect(card?.preview).toEqual({ kind: "browser-tab", ...browserDetails.browserTab });
    expect(card?.outputText).toBe("browser output");
  });

  it("keeps routing and raw output without unsafe browser previews", () => {
    const browserTab = browserTarget;
    const url = "javascript:void(0)";
    const details = { browserTab: { ...browserTab, url } };
    const output = JSON.stringify({ url });
    const card = browserCard(details.browserTab, { content: output });
    expect([card?.outputText, card?.details]).toEqual([output, details]);
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
    expectNoBrowser(browserCard(browserTab, { role: "tool" }));
  });

  it("retains exact bounded node identities without provider metadata", () => {
    const browserTab = {
      targetId: "t".repeat(128),
      profile: "p".repeat(128),
      target: "node",
      node: "n".repeat(256),
    };
    const card = browserCard({
      ...browserTab,
      cdpUrl: "https://private.example/",
      token: "not-a-real-token",
    });
    expect(card?.browserTab).toEqual(browserTab);
    expect(card?.preview).toBeUndefined();
  });

  it("drops non-string browser metadata and gives canvas previews precedence", () => {
    const browserTab = { ...browserTarget, url: 42, title: [] };
    expect(browserCard(browserTab, { role: "tool" })?.preview).toBeUndefined();
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

  it("keeps a same-name result with different legacy call IDs separate from an open call", () => {
    const cards = assistantCards([
      { type: "tool_use", id: "call-a", name: "read" },
      { type: "tool_result", callId: "call-b", name: "read", text: "B failed", isError: true },
    ]);

    expect(
      cards.map(({ callId, name, completed, outputText, isError }) => [
        callId,
        name,
        completed,
        outputText,
        isError,
      ]),
    ).toEqual([
      ["call-a", "read", undefined, undefined, undefined],
      ["call-b", "read", true, "B failed", true],
    ]);
  });

  it.each([
    ["only the call owns an ID", { id: "call-a" }, {}],
    ["only the result owns an ID", {}, { tool_use_id: "call-b" }],
  ])("preserves legacy same-name fallback when %s", (_label, callId, resultId) => {
    const cards = assistantCards([
      { type: "tool_use", ...callId, name: "read" },
      { type: "tool_result", ...resultId, name: "read", text: "Legacy contents" },
    ]);

    expect(cards).toMatchObject([{ name: "read", completed: true, outputText: "Legacy contents" }]);
  });

  it("does not reuse nameless same-name calls after an empty result", () => {
    const cards = assistantCards([
      { type: "tool_use", name: "read", input: { path: "empty.txt" } },
      { type: "tool_use", name: "read", input: { path: "next.txt" } },
      { type: "tool_result", name: "read", text: "" },
      { type: "tool_result", name: "read", text: "Next contents" },
    ]);

    expect(cards.map(({ inputText, outputText }) => [inputText, outputText])).toEqual([
      ['{\n  "path": "empty.txt"\n}', ""],
      ['{\n  "path": "next.txt"\n}', "Next contents"],
    ]);
    expect(cards[0]?.completed).toBe(true);
  });
});

const entry = "/__openclaw__/canvas/documents/cv_demo/index.html";
const host = "http://127.0.0.1:19003/__openclaw__/cap/cap_123";
it.each([
  [entry, undefined, false, entry],
  [entry, host, false, `${host}${entry}`],
  ["/not-canvas/snake.html", undefined, false, undefined],
  ["https://example.com/evil.html", undefined, false, undefined],
  ["file:///tmp/snake.html", undefined, true, undefined],
  ["https://example.com/embed.html?x=1#y", undefined, true, "https://example.com/embed.html?x=1#y"],
] as const)(
  "scopes canvas URL %s to %s with external=%s",
  (url, capabilityHost, external, expected) => {
    expect(resolveCanvasIframeUrl(url, capabilityHost, external)).toBe(expected);
  },
);

describe("tool card outcomes", () => {
  it("keeps error-shaped partial output nonterminal until the live result arrives", () => {
    const text = '{"error": "partial text"}';
    const stream = (output: string, received: boolean) =>
      assistantCards(
        [
          { type: "toolcall", name: "bash" },
          { type: "toolresult", name: "bash", text: output },
        ],
        {
          toolCallId: "call-live",
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: received,
        },
      );
    const partial = stream(text, false);
    expect(partial).toMatchObject([{ live: true, completed: false, outputText: text }]);
    expect(partial.map(isToolCardError)).toEqual([false]);
    expect(partial.map((card) => resolveToolCardOutcome(card, true))).toEqual(["running"]);
    expect(partial.map((card) => resolveToolCardOutcome(card, false))).toEqual(["unknown"]);

    const done = stream("ok", true);
    expect(done[0]).toMatchObject({ live: true, completed: true });
    expect(done.map((card) => resolveToolCardOutcome(card, true))).toEqual(["succeeded"]);
  });

  it.each(["start", "end", "terminal"] as const)(
    "keeps an unrecorded activity outcome unknown: %s",
    (state) => {
      const terminal = state === "terminal";
      const id = terminal ? "call-done" : "call-live";
      const phase = state === "start" ? "start" : "end";
      const [card] = assistantCards(
        [
          { type: "toolcall", id, name: "bash" },
          ...(terminal ? [{ type: "toolresult", id, name: "bash", text: "ok" }] : []),
        ],
        {
          activity: [activity(id, phase, terminal ? "Outcome unknown" : undefined)],
          ...(!terminal
            ? { __openclawToolStreamLive: true, __openclawToolStreamResultReceived: false }
            : {}),
        },
      );
      expect(card?.activity?.status).toBeUndefined();
      if (!terminal) {
        expect(resolveToolCardOutcome(card!, true)).toBe(state === "start" ? "running" : "unknown");
      }
      expect(resolveToolCardOutcome(card!, false)).toBe("unknown");
      if (terminal) {
        expect(card).toMatchObject({ completed: true, outputText: "ok" });
      }
    },
  );
});
