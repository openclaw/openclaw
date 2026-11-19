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
function messageGroups(
  searchQuery: string,
  messages: unknown[],
  props: Partial<CachedChatItemsProps> = {},
) {
  return groupsOf(
    buildCachedChatItems(createProps({ ...props, messages, searchOpen: true, searchQuery })),
  );
}

it.each([
  ["inline code", "Title: fix(review)", "Title: `fix(review): keep proof`"],
  ["emphasis", "ready for review", "**Ready** for _review_"],
  ["plain prose whitespace", "17.\tSynthetic", "Transcript 0 message 17.\nSynthetic detail."],
  ["Unicode case folding", "ſearch", "**Search**"],
  ["composed query", "CAFÉ now", "**Cafe**\u0301 now"],
  ["decomposed query", "cafe\u0301 now", "**Café** now"],
  ["hex color", "Use #ffffff now", "**Use** #ffffff now"],
  ["link label", "see the docs", "See [the docs](https://docs.openclaw.ai/chat)"],
  ["link target", "docs.openclaw.ai/chat", "See [the docs](https://docs.openclaw.ai/chat)"],
  ["html block", "proof steps", "<details>\n<summary>Proof</summary>\n\nsteps\n</details>"],
  ["shortened file link", "open foo.ts now", "Open `/tmp/src/foo.ts` now"],
])("matches transcript search across %s", (_case, query, source) => {
  const texts = messageGroups(query, [
    user("Unrelated prompt", 1_000),
    assistant(source, 1_001),
    assistant("Title: fix(other)", 1_002),
  ]).flatMap((group) => group.messages.map(({ message }) => normalizeMessage(message).content));

  expect(texts).toEqual([[{ type: "text", text: source }]]);
});

it.each([
  ["raw HTML", "hello <b>world</b>"],
  ["a message above the parse budget", `**hello** world ${"x".repeat(40_000)}`],
  ["a JSON message", '{"value":"**hello** world"}'],
  ["text around an image", "Hello ![chart](https://example.com/chart.png) world"],
])("does not match across content the transcript renders differently: %s", (_case, source) => {
  const groups = messageGroups("hello world", [assistant(source, 1_000)]);

  expect(groups).toEqual([]);
});

it("does not omit a visible color when matching a phrase", () => {
  expect(messageGroups("Use now", [assistant("**Use** #fff now", 1_000)])).toEqual([]);
});

it.each(["1. hello", "1.\nhello"])("does not treat ordered-list markers as prose: %s", (source) => {
  expect(messageGroups("1.\thello", [assistant(source, 1_000)])).toEqual([]);
});

it("keeps selected mention labels literal while searching surrounding formatting", () => {
  const source = "**Ask** @**Ada** now";
  const message = user(source, 1_000, {
    __openclaw: { humanMentions: [{ profileId: "ada", start: 8, end: 16 }] },
  });
  expect(messageGroups("Ask **Ada** now", [message])).toHaveLength(1);
  expect(messageGroups("Ask @Ada now", [message])).toEqual([]);
  expect(messageGroups("@**Ada** now", [message])).toHaveLength(1);
});

it("searches recovered Markdown with the document rendering budget", () => {
  const message = assistant("Preview", 1_000, { __openclaw: { id: "full", truncated: true } });
  const markdown = "**Use** #fff now " + "x".repeat(40_000);
  expect(
    messageGroups("Use #fff now", [message], {
      messageRecovery: {
        revision: 1,
        messages: new Map([
          [messageRecoveryKey(undefined, "full"), { status: "loaded", markdown, revision: 1 }],
        ]),
      },
    }),
  ).toHaveLength(1);
});
