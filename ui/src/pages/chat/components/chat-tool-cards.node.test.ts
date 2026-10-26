// @vitest-environment node

import { expect, it } from "vitest";
import { resolveCanvasIframeUrl } from "../../../lib/chat/canvas-embed-policy.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import {
  extractToolCardsCached as extractToolCards,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";

const assistantCards = (content: unknown[], metadata: Record<string, unknown> = {}) =>
  extractToolCards({ role: "assistant", content, ...metadata });

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
  expect(card).toMatchObject({ name: "browser", outputText: browserOutput });
  expect(card?.preview).toEqual(
    toolName === "browser" ? { kind: "browser-tab", ...browserDetails.browserTab } : undefined,
  );
  expect(card?.browserTab).toEqual(toolName === "browser" ? browserTarget : undefined);
});

const nodeTarget = {
  targetId: "t".repeat(128),
  profile: "p".repeat(128),
  target: "node",
  node: "n".repeat(256),
};
it.each([
  [{}, undefined],
  [{ targetId: " " }, undefined],
  [{ targetId: "t1" }, undefined],
  [{ targetId: "t1", profile: "managed", target: "node" }, undefined],
  [{ targetId: "t1", profile: "managed", target: "host", node: "node-a" }, undefined],
  [{ targetId: "t".repeat(129), profile: "managed", target: "host" }, undefined],
  [{ ...nodeTarget, cdpUrl: "https://private.example/", token: "synthetic" }, nodeTarget],
  [{ ...browserTarget, url: "javascript:void(0)" }, browserTarget],
  [{ ...browserTarget, url: 42, title: [] }, browserTarget],
])(
  "retains only an exact route and suppresses unsafe preview metadata (%j)",
  (browserTab, target) => {
    const output = JSON.stringify(browserTab);
    const card = browserCard(browserTab, { role: "tool", content: output });
    expect([card?.outputText, card?.details, card?.browserTab, card?.preview]).toEqual([
      output,
      { browserTab },
      target,
      undefined,
    ]);
  },
);

it("gives canvas previews precedence over browser metadata", () => {
  const browserTab = { ...browserTarget, url: 42, title: [] };
  const canvas = { kind: "canvas", view: { id: "cv_app" }, mcpApp: { viewId: "cv_app" } };
  for (const toolName of ["browser", "canvas_render"]) {
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

it.each([
  [false, '{"error": "partial text"}', "running", "unknown"],
  [true, "ok", "succeeded", "succeeded"],
] as const)(
  "settles live output only with a result receipt: %s",
  (received, text, active, idle) => {
    const cards = assistantCards(
      [
        { type: "toolcall", name: "bash" },
        { type: "toolresult", name: "bash", text },
      ],
      {
        toolCallId: "call-live",
        __openclawToolStreamLive: true,
        __openclawToolStreamResultReceived: received,
      },
    );
    expect(cards).toMatchObject([{ live: true, completed: received, outputText: text }]);
    expect(
      cards.map((card) => [
        resolveToolCardOutcome(card, true),
        resolveToolCardOutcome(card, false),
      ]),
    ).toEqual([[active, idle]]);
  },
);

it.each(["start", "end"] as const)("keeps unknown activity: %s", (phase) => {
  const card: ToolCard = {
    id: "call-live",
    name: "bash",
    live: true,
    completed: false,
    activity: { itemId: "tool:call-live", kind: "tool", phase, title: "Outcome unknown" },
  };
  expect(resolveToolCardOutcome(card, true)).toBe(phase === "start" ? "running" : "unknown");
  expect(resolveToolCardOutcome(card, false)).toBe("unknown");
});
