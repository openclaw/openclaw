// @vitest-environment node

import { expect, it } from "vitest";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import {
  extractToolCardsCached as extractToolCards,
  isToolCardError,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { resolveCanvasIframeUrl } from "../../../lib/chat/tool-display.ts";

const assistantCards = (content: unknown[], metadata: Record<string, unknown> = {}) =>
  extractToolCards({ role: "assistant", content, ...metadata });

const expectNoBrowser = (card: ToolCard | undefined) =>
  expect([card?.preview, card?.browserTab]).toEqual([undefined, undefined]);

const browserCard = (browserTab: unknown, fields: Record<string, unknown> = {}) =>
  extractToolCards({
    role: "toolResult",
    toolName: "browser",
    details: { browserTab },
    ...fields,
  })[0];

const browserTarget = { profile: "managed", target: "host", targetId: "tab-origin" };
const browserDetails = { browserTab: { ...browserTarget, url: "https://example.com" } };
const browserOutput = "Tool output";
const browserResult = (fields: Record<string, unknown> = {}) => ({
  type: "tool_result",
  text: browserOutput,
  details: browserDetails,
  ...fields,
});

it.each([
  ["browser", "read", true],
  ["read", "browser", true],
  ["browser", undefined, false],
] as const)("trusts paired origin: %s / %s paired=%s", (callName, resultName, paired) => {
  const cards = assistantCards([
    { type: "toolcall", id: "origin", name: callName },
    browserResult({
      [paired ? "tool_use_id" : "id"]: paired ? "origin" : "unpaired",
      name: resultName,
    }),
  ]);
  expect(cards).toHaveLength(paired ? 1 : 2);
  const card = cards.at(-1);
  if (paired) {
    expect(card?.name).toBe(callName);
  }
  expect(card?.outputText).toBe(browserOutput);
  const browserOrigin = paired && callName === "browser";
  expect(card?.preview).toEqual(
    browserOrigin ? { kind: "browser-tab", ...browserDetails.browserTab } : undefined,
  );
  expect(card?.browserTab).toEqual(browserOrigin ? browserTarget : undefined);
});

it.each([
  ["toolName", "browser.open", false],
  ["toolName", "browser.open", true],
  ["tool_name", "browser.open", false],
  ["tool_name", "browser.open", true],
  ["tool_name", "browser", false],
] as const)("uses envelope origin: %s=%s paired=%s", (nameField, toolName, paired) => {
  const [card] = extractToolCards({
    role: "toolResult",
    [nameField]: toolName,
    content: [
      ...(paired ? [{ type: "toolcall", id: "nested", name: "browser" }] : []),
      browserResult({
        name: toolName === "browser" ? undefined : "browser",
        id: paired ? "nested" : undefined,
      }),
    ],
  });
  expect(card?.outputText).toBe(browserOutput);
  if (toolName === "browser") {
    expect(card?.preview).toEqual({ kind: "browser-tab", ...browserDetails.browserTab });
  } else {
    expect(card?.name).toBe("browser");
    expectNoBrowser(card);
  }
});

it("keeps routing and raw output without unsafe browser previews", () => {
  const url = "javascript:void(0)";
  const details = { browserTab: { ...browserTarget, url } };
  const output = JSON.stringify({ url });
  const card = browserCard(details.browserTab, { content: output });
  expect([card?.outputText, card?.details]).toEqual([output, details]);
  expect(card?.preview).toBeUndefined();
  expect(card?.browserTab).toEqual(browserTarget);
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
  const canvas = { kind: "canvas", view: { id: "cv_app" }, mcpApp: { viewId: "cv_app" } };
  for (const toolName of [undefined, "browser", "canvas_render"]) {
    const message = {
      role: "tool",
      toolName,
      details: { browserTab, ...(toolName === "canvas_render" ? {} : { mcpAppPreview: canvas }) },
      ...(toolName === "canvas_render" ? { content: JSON.stringify(canvas) } : {}),
    };
    expect(extractToolCards(message)[0]?.preview?.kind).toBe("canvas");
  }
});

it("keeps a same-name result with different legacy call IDs separate from an open call", () => {
  const cards = assistantCards([
    { type: "tool_use", id: "call-a", name: "read" },
    { type: "tool_result", callId: "call-b", name: "read", text: "B failed", isError: true },
  ]);

  expect(
    cards.map((card) => [card.callId, card.name, card.completed, card.outputText, card.isError]),
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

const entry = "/__openclaw__/canvas/documents/cv_demo/index.html";
const host = "http://127.0.0.1:19003/__openclaw__/cap/cap_123";
it.each([
  [entry, undefined, false, entry],
  [entry, host, false, `${host}${entry}`],
  ["/not-canvas/snake.html", undefined, false, undefined],
  ["https://example.com/evil.html", undefined, false, undefined],
  ["file:///tmp/snake.html", undefined, true, undefined],
  ["https://example.com/embed.html?x=1#y", undefined, true, "https://example.com/embed.html?x=1#y"],
] as const)("scopes canvas: %s %s external=%s", (url, capabilityHost, external, expected) => {
  expect(resolveCanvasIframeUrl(url, capabilityHost, external)).toBe(expected);
});

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

it.each(["start", "end", "terminal"] as const)("keeps unknown activity: %s", (state) => {
  const terminal = state === "terminal";
  const id = terminal ? "call-done" : "call-live";
  const phase = state === "start" ? "start" : "end";
  const [card] = assistantCards(
    [
      { type: "toolcall", id, name: "bash" },
      ...(terminal ? [{ type: "toolresult", id, name: "bash", text: "ok" }] : []),
    ],
    {
      activity: [
        {
          itemId: `tool:${id}`,
          toolCallId: id,
          kind: "tool",
          phase,
          title: "Command — outcome unknown",
          ...(terminal ? { summary: "Outcome unknown" } : {}),
        },
      ],
      ...(!terminal
        ? { __openclawToolStreamLive: true, __openclawToolStreamResultReceived: false }
        : {}),
    },
  );
  expect(card?.activity?.status).toBeUndefined();
  if (terminal) {
    expect(card).toMatchObject({ completed: true, outputText: "ok" });
  } else {
    expect(resolveToolCardOutcome(card!, true)).toBe(state === "start" ? "running" : "unknown");
  }
  expect(resolveToolCardOutcome(card!, false)).toBe("unknown");
});
