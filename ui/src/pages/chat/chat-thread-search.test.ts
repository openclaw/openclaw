// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { messageRecoveryKey } from "./chat-message-recovery.ts";
import { groupsOf, message as chatMessage } from "./chat-thread-fixtures.test-support.ts";
import { createProps, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

beforeEach(() => resetChatThreadState());
const user = chatMessage.bind(null, "user");
const assistant = chatMessage.bind(null, "assistant");
const messageGroups = (props: Partial<CachedChatItemsProps>) =>
  groupsOf(buildCachedChatItems(createProps(props)));

it.each([
  ["inline code", "Title: fix(review)", "Title: `fix(review): keep proof`"],
  ["emphasis", "ready for review", "**Ready** for _review_"],
  ["plain prose whitespace", "17.\tSynthetic", "Transcript 0 message 17.\nSynthetic detail."],
  ["Unicode case folding", "ſearch", "**Search**"],
  ["composed query", "CAFÉ now", "**Cafe**\u0301 now"],
  ["decomposed query", "cafe\u0301 now", "**Café** now"],
  ["hex color", "Use #fff now", "**Use** #fff now"],
  ["link label", "see the docs", "See [the docs](https://docs.openclaw.ai/chat)"],
  ["link target", "docs.openclaw.ai/chat", "See [the docs](https://docs.openclaw.ai/chat)"],
  ["html block", "proof steps", "<details>\n<summary>Proof</summary>\n\nsteps\n</details>"],
  ["shortened file link", "open foo.ts now", "Open `/tmp/src/foo.ts` now"],
])("matches transcript search across %s", (_case, query, source) => {
  const texts = messageGroups({
    messages: [
      user("Unrelated prompt", 1_000),
      assistant(source, 1_001),
      assistant("Title: fix(other)", 1_002),
    ],
    searchOpen: true,
    searchQuery: query,
  }).flatMap((group) => group.messages.map(({ message }) => normalizeMessage(message).content));

  expect(texts).toEqual([[{ type: "text", text: source }]]);
});

it.each([
  ["raw HTML", "hello <b>world</b>"],
  ["a message above the parse budget", `**hello** world ${"x".repeat(40_000)}`],
  ["a JSON message", '{"value":"**hello** world"}'],
  ["text around an image", "Hello ![chart](https://example.com/chart.png) world"],
])("does not match across content the transcript renders differently: %s", (_case, source) => {
  const groups = messageGroups({
    messages: [assistant(source, 1_000)],
    searchOpen: true,
    searchQuery: "hello world",
  });

  expect(groups).toEqual([]);
});

it("does not omit a visible color when matching a phrase", () => {
  expect(
    messageGroups({
      messages: [assistant("**Use** #fff now", 1_000)],
      searchOpen: true,
      searchQuery: "Use now",
    }),
  ).toEqual([]);
});

it.each(["1. hello", "1.\nhello"])("does not treat ordered-list markers as prose: %s", (source) => {
  expect(
    messageGroups({
      messages: [assistant(source, 1_000)],
      searchOpen: true,
      searchQuery: "1.\thello",
    }),
  ).toEqual([]);
});

it("keeps selected mention labels literal while searching surrounding formatting", () => {
  const source = "**Ask** @**Ada** now";
  const message = user(source, 1_000, {
    __openclaw: { humanMentions: [{ profileId: "ada", start: 8, end: 16 }] },
  });
  expect(
    messageGroups({ messages: [message], searchOpen: true, searchQuery: "Ask **Ada** now" }),
  ).toHaveLength(1);
  expect(
    messageGroups({ messages: [message], searchOpen: true, searchQuery: "Ask @Ada now" }),
  ).toEqual([]);
  expect(
    messageGroups({ messages: [message], searchOpen: true, searchQuery: "@**Ada** now" }),
  ).toHaveLength(1);
});

it("searches recovered Markdown with the document rendering budget", () => {
  const message = assistant("Preview", 1_000, { __openclaw: { id: "full", truncated: true } });
  const markdown = "**Use** #fff now " + "x".repeat(40_000);
  expect(
    messageGroups({
      messages: [message],
      searchOpen: true,
      searchQuery: "Use #fff now",
      messageRecovery: {
        revision: 1,
        messages: new Map([
          [messageRecoveryKey(undefined, "full"), { status: "loaded", markdown, revision: 1 }],
        ]),
      },
    }),
  ).toHaveLength(1);
});
