/* @vitest-environment jsdom */

// Keep the server sanitizer in the Node lane; the browser never imports this owner.
import { expect, it, vi } from "vitest";
import { sanitizeChatHistoryMessages } from "../../../../../src/gateway/chat-display-projection.sanitize.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { MessageGroup } from "./chat-message-group-view.tsx";
import { createMessageGroup } from "./chat-message.test-support.ts";

// mock-isolation: Text-only histories must not load media storage into jsdom; fail if used.
vi.mock("../../../../../src/media/media-reference.js", () => ({
  parseInboundMediaUri: () => {
    throw new Error("Unexpected media URI in text-only context history");
  },
  buildInboundMediaUriFromPath: () => {
    throw new Error("Unexpected media path in text-only context history");
  },
}));

function historyMessage(usage: Record<string, unknown>, timestamp = 1000) {
  return { role: "assistant", content: "The report is ready.", timestamp, usage };
}

function renderHistory(messages: unknown[]) {
  const sanitized = sanitizeChatHistoryMessages(messages);
  const group = createMessageGroup(sanitized[0], "assistant", {
    messages: sanitized.map((message, index) => ({ key: String(index), message })),
  });
  const view = mountSolid(() => (
    <MessageGroup group={group} options={{ showReasoning: false, contextWindow: 200_000 }} />
  ));
  flush();
  return view.container;
}

it.each([
  { name: "unavailable context", contextUsage: { state: "unavailable" }, expected: null },
  {
    name: "available context",
    contextUsage: { state: "available", promptTokens: 20_000, totalTokens: 20_010 },
    expected: "10% ctx",
  },
  {
    name: "measured zero context",
    contextUsage: { state: "available", promptTokens: 0, totalTokens: 0 },
    expected: null,
  },
  { name: "legacy usage", contextUsage: undefined, expected: "75% ctx" },
])("renders sanitized $name independently from billing", ({ contextUsage, expected }) => {
  const container = renderHistory([
    historyMessage({
      input: 75_000,
      output: 100,
      cacheRead: 75_000,
      cost: { total: 0.25 },
      contextUsage,
    }),
  ]);
  expect(container.querySelector(".msg-meta__ctx")?.textContent ?? null).toBe(expected);
  expect(container.querySelector(".msg-meta__cost")?.textContent).toBe("$0.250");
  expect([...container.querySelectorAll(".msg-meta__tokens")].map((el) => el.textContent)).toEqual([
    "↑75k",
    "↓100",
  ]);
  expect(container.querySelector(".msg-meta__cache")?.textContent).toBe("R75k");
});

it.each([
  { reversed: false, unavailable: false },
  { reversed: true, unavailable: false },
  { reversed: false, unavailable: true },
  { reversed: true, unavailable: true },
])(
  "prefers context snapshots over legacy billing (reversed: $reversed, unavailable: $unavailable)",
  ({ reversed, unavailable }) => {
    const messages = [
      historyMessage({ input: 150_000, output: 10 }),
      historyMessage(
        {
          input: 100_000,
          output: 20,
          contextUsage: unavailable
            ? { state: "unavailable" }
            : { state: "available", promptTokens: 20_000, totalTokens: 20_020 },
        },
        2000,
      ),
    ];
    if (reversed) {
      messages.reverse();
    }
    const container = renderHistory(messages);
    expect(container.querySelector(".msg-meta__ctx")?.textContent ?? null).toBe(
      unavailable ? null : "10% ctx",
    );
    expect(container.querySelector(".msg-meta__tokens")?.textContent).toBe("↑250k");
  },
);
