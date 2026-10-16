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
  const [message] = sanitizeChatHistoryMessages([
    {
      role: "assistant",
      content: "The report is ready.",
      timestamp: 1000,
      usage: {
        input: 75_000,
        output: 100,
        cacheRead: 75_000,
        cost: { total: 0.25 },
        contextUsage,
      },
    },
  ]);
  const view = mountSolid(() => (
    <MessageGroup
      group={createMessageGroup(message, "assistant")}
      options={{ showReasoning: false, contextWindow: 200_000 }}
    />
  ));
  flush();
  expect(view.container.querySelector(".msg-meta__ctx")?.textContent ?? null).toBe(expected);
  expect(view.container.querySelector(".msg-meta__cost")?.textContent).toBe("$0.250");
  expect(
    [...view.container.querySelectorAll(".msg-meta__tokens")].map((el) => el.textContent),
  ).toEqual(["↑75k", "↓100"]);
  expect(view.container.querySelector(".msg-meta__cache")?.textContent).toBe("R75k");
});

it.each([
  { reversed: false, unavailable: false },
  { reversed: true, unavailable: false },
  { reversed: false, unavailable: true },
  { reversed: true, unavailable: true },
])(
  "prefers context snapshots over legacy billing (reversed: $reversed, unavailable: $unavailable)",
  ({ reversed, unavailable }) => {
    const messages = sanitizeChatHistoryMessages([
      {
        role: "assistant",
        content: "First reply.",
        timestamp: 1000,
        usage: { input: 150_000, output: 10 },
      },
      {
        role: "assistant",
        content: "Final reply.",
        timestamp: 2000,
        usage: {
          input: 100_000,
          output: 20,
          contextUsage: unavailable
            ? { state: "unavailable" }
            : { state: "available", promptTokens: 20_000, totalTokens: 20_020 },
        },
      },
    ]);
    if (reversed) {
      messages.reverse();
    }
    const group = createMessageGroup(messages[0], "assistant", {
      messages: messages.map((message, index) => ({ key: String(index), message })),
    });
    const view = mountSolid(() => (
      <MessageGroup group={group} options={{ showReasoning: false, contextWindow: 200_000 }} />
    ));
    flush();
    expect(view.container.querySelector(".msg-meta__ctx")?.textContent ?? null).toBe(
      unavailable ? null : "10% ctx",
    );
    expect(view.container.querySelector(".msg-meta__tokens")?.textContent).toBe("↑250k");
  },
);
