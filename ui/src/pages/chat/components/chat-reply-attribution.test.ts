/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderAgentRunFrame } from "./chat-agent-run-frame.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";

const alice = { id: "alice", name: "Alice" };
const prompt = {
  role: "user",
  content: "Original question",
  __openclaw: { id: "prompt", senderId: "alice", senderName: "Alice" },
};
// A 1:1 turn whose own prompt is loaded: a reference to anything else is older.
const turnSource = { replyTurnSource: { key: "prompt-render-key", message: prompt } };
let container: HTMLDivElement;
afterEach(() => {
  if (container) {
    render(null, container);
    container.remove();
  }
});

function draw(
  source: unknown = prompt,
  replies: unknown[] = [{ role: "assistant", content: "Answer" }],
  loaded = true,
  presentation: "group" | "frame" = "group",
  context: Partial<MessageGroup> & {
    /** Originals a `chat.message.get` lookup returned outside the loaded history. */
    fetched?: Record<string, unknown>;
    missing?: string[];
    oversized?: string[];
    pending?: string[];
    sources?: Record<string, { message: unknown; senderLabel: string }>;
  } = {},
) {
  const {
    fetched = {},
    missing = [],
    oversized = [],
    pending = [],
    sources = {},
    ...groupContext
  } = context;
  container = document.body.appendChild(document.createElement("div"));
  const group: MessageGroup = {
    kind: "group",
    key: "answer-group",
    role: "assistant",
    timestamp: 1,
    isStreaming: false,
    visibleContent: "text",
    senderLabel: "Alice",
    replyToSender: alice,
    replyToMessage: { key: "prompt-render-key", message: source },
    ...groupContext,
    messages: replies.map((message, index) => ({
      message,
      key: `answer-${index}`,
      hasVisibleContent: true,
    })),
  };
  const onOpenReply = vi.fn();
  const resolveReplyPreview = createReplyPreviewResolver(
    new Map(
      Object.entries({
        ...(loaded ? { prompt: { message: source, senderLabel: "Alice" } } : {}),
        ...sources,
      }).map(
        ([id, loadedSource]) => [id, { ...loadedSource, messageId: `${id}-render-key` }] as const,
      ),
    ),
    {
      assistantName: "Assistant",
      replyMessageAccess: {
        read: (id) => fetched[id],
        status: (id) =>
          missing.includes(id)
            ? "missing"
            : oversized.includes(id)
              ? "oversized"
              : pending.includes(id)
                ? "pending"
                : undefined,
      },
    },
  );
  const options = {
    showReasoning: false,
    showToolCalls: false,
    avatarPlacement: "none" as const,
    onOpenReply,
    resolveReplyPreview,
  };
  render(
    presentation === "frame"
      ? renderAgentRunFrame(
          {
            kind: "agent-run-frame",
            key: "frame",
            runId: "run",
            boundaryId: "prompt",
            outcome: { kind: "completed", actionOwner: group.messages.at(-1) ?? null },
            parts: group.messages.map((entry, index) => ({
              ...group,
              key: `frame-part-${index}`,
              messages: [entry],
            })),
          },
          {
            streamOptions: {},
            renderGroupOptions: () => options,
            isWorkExpanded: () => false,
            onToggleWork: () => undefined,
          },
        )
      : renderMessageGroup(group, options),
    container,
  );
  return {
    onOpenReply,
    row: container.querySelector<HTMLElement>(".chat-reply-attribution--reply")!,
  };
}

it("renders one recipient per group and navigates from the name by persisted ID", () => {
  const { row, onOpenReply } = draw(prompt, [
    { role: "assistant", content: "First answer" },
    { role: "assistant", content: "Second answer", __openclaw: { replyToId: "prompt" } },
  ]);
  expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(1);
  expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
  expect(row.textContent).not.toContain("Original question");
  const target = row.querySelector<HTMLButtonElement>("button")!;
  expect(target.getAttribute("aria-label")).toBe("Replying to Alice");
  expect(target.querySelector(".chat-author-avatar")).not.toBeNull();
  expect(target.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Alice");
  target.click();
  expect(onOpenReply).toHaveBeenCalledWith("prompt");
});

const agentAnswer = { role: "assistant", content: "Earlier answer", __openclaw: { id: "earlier" } };
const jordan = { id: "jordan", name: "Jordan" };
const typedJordan = { ...jordan, identity: { type: "profile", id: "jordan" } } as const;

it.each([
  {
    replier: "an untyped participant replying to the agent",
    role: "user",
    sender: jordan,
    original: agentAnswer,
    strip: "OpenClaw",
    senderName: "Jordan",
  },
  {
    replier: "the agent replying to its own earlier answer",
    role: "assistant",
    sender: undefined,
    original: agentAnswer,
    strip: "OpenClaw",
    senderName: null,
  },
  {
    replier: "the agent replying to a different participant with the same name",
    role: "assistant",
    sender: undefined,
    original: {
      role: "user",
      content: "Earlier question",
      __openclaw: {
        id: "earlier",
        senderId: "namesake",
        senderName: "OpenClaw",
        senderIdentity: { type: "profile", id: "namesake" },
      },
    },
    strip: "OpenClaw",
    senderName: "OpenClaw",
  },
  {
    // A peer's strip sits on the message itself, so the footer keeps their name.
    replier: "a typed participant replying to their own earlier message",
    role: "user",
    sender: typedJordan,
    original: {
      role: "user",
      content: "Earlier question",
      __openclaw: {
        id: "earlier",
        senderId: "jordan",
        senderName: "Jordan",
        senderIdentity: typedJordan.identity,
      },
    },
    strip: "Jordan",
    senderName: "Jordan",
  },
] as const)(
  "keeps the sender name of $replier unless the group strip names that same identity",
  ({ role, sender, original, strip, senderName }) => {
    container = document.body.appendChild(document.createElement("div"));
    const resolveReplyPreview = createReplyPreviewResolver(
      new Map([["earlier", { message: original, messageId: "earlier-key", senderLabel: strip }]]),
      { assistantName: "OpenClaw", userId: "alice" },
    );
    render(
      renderMessageGroup(
        {
          kind: "group",
          key: "reply-group",
          role,
          timestamp: 1,
          isStreaming: false,
          visibleContent: "text",
          replyShared: true,
          ...(sender ? { sender, senderLabel: sender.name } : {}),
          messages: [
            {
              key: "reply",
              hasVisibleContent: true,
              message: {
                role,
                content: "Reply",
                __openclaw: { id: "reply", replyToId: "earlier" },
              },
            },
          ],
        },
        {
          showReasoning: false,
          showToolCalls: false,
          avatarPlacement: "none",
          userId: "alice",
          assistantName: "OpenClaw",
          resolveReplyPreview,
        },
      ),
      container,
    );
    expect(
      container.querySelector(".chat-reply-attribution--reply .chat-reply-attribution__name")
        ?.textContent,
    ).toBe(strip);
    expect(container.querySelector(".chat-sender-name")?.textContent ?? null).toBe(senderName);
  },
);

it.each([
  { snapshot: undefined, missing: [] },
  // Only the original's run ownership tells an older prompt from this turn's own.
  { snapshot: { senderLabel: "Jordan", text: "Earlier question" }, missing: [] },
  { snapshot: { senderLabel: "Jordan", text: "" }, missing: ["deleted"] },
])(
  "renders no strip in a 1:1 turn without its prompt for an unresolved or missing reference %o",
  ({ snapshot, missing }) => {
    draw(
      prompt,
      [
        {
          role: "assistant",
          content: "Answer",
          __openclaw: { replyToId: "deleted", replyToPreview: snapshot },
        },
      ],
      false,
      "group",
      { missing },
    );
    expect(container.querySelector(".chat-reply-attribution")).toBeNull();
    expect(container.textContent).not.toContain("Original message unavailable");
  },
);

it.each([
  { lookup: "pending", snapshot: undefined, name: undefined, unavailable: undefined },
  { lookup: "missing", snapshot: undefined, name: undefined, unavailable: true },
  {
    lookup: "missing",
    snapshot: { senderLabel: "Jordan", text: "" },
    name: "Jordan",
    unavailable: true,
  },
] as const)(
  "keeps a reserved strip row through a $lookup lookup (name $name)",
  ({ lookup, snapshot, name, unavailable }) => {
    const { row } = draw(
      prompt,
      [
        {
          role: "assistant",
          content: "Answer",
          __openclaw: { replyToId: "deleted", ...(snapshot ? { replyToPreview: snapshot } : {}) },
        },
      ],
      false,
      "group",
      {
        replyShared: true,
        ...(lookup === "pending" ? { pending: ["deleted"] } : { missing: ["deleted"] }),
      },
    );
    // A transport failure reads as pending until a new connection answers.
    expect(row.classList.contains("chat-reply-attribution--pending")).toBe(!unavailable);
    expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
    expect(Boolean(row.querySelector(".chat-reply-attribution__person"))).toBe(Boolean(name));
    expect(row.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
      unavailable ? "Original message unavailable" : undefined,
    );
    expect(row.querySelector(".chat-author-avatar, button, a")).toBeNull();
  },
);

it.each([
  { presentation: "group", shared: true },
  { presentation: "group", shared: false },
  { presentation: "frame", shared: false },
] as const)(
  "paints a sender-only snapshot on the first frame and settles it in place ($presentation, shared $shared)",
  ({ presentation, shared }) => {
    const replyShared = shared || undefined;
    const replies = [
      {
        role: "assistant",
        content: "Answer",
        __openclaw: {
          replyToId: "older",
          replyToPreview: { senderLabel: "Jordan", text: "" },
        },
      },
    ];
    // The lookup has not answered yet: the name alone fills the strip.
    const context = { replyShared, ...turnSource };
    const first = draw(prompt, replies, false, presentation, { ...context, pending: ["older"] });
    const firstContainer = container;
    expect(first.row.classList.contains("chat-reply-attribution--pending")).toBe(false);
    expect(first.row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
    expect(first.row.querySelector(".chat-author-avatar")).not.toBeNull();
    expect(first.row.querySelector(".chat-reply-attribution__unavailable")).toBeNull();
    // A later authoritative page can confirm that the original is missing.
    render(null, firstContainer);
    firstContainer.remove();

    // A lookup that confirms the original is gone keeps the name in the same row.
    const settled = draw(prompt, replies, false, presentation, { ...context, missing: ["older"] });
    expect(settled.row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
    expect(settled.row.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
      "Original message unavailable",
    );
    expect(settled.row.querySelector(".chat-author-avatar, button, a")).toBeNull();
  },
);

it.each(["group", "frame"] as const)(
  "keeps a later name-only snapshot for an unavailable source in a %s",
  (presentation) => {
    const { row } = draw(
      prompt,
      [
        { role: "assistant", content: "First answer", __openclaw: { replyToId: "deleted" } },
        {
          role: "assistant",
          content: "Further details",
          __openclaw: {
            replyToId: "deleted",
            replyToPreview: { senderLabel: "Jordan", text: "" },
          },
        },
      ],
      false,
      presentation,
      { ...turnSource, missing: ["deleted"] },
    );
    expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
    expect(row.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
      "Original message unavailable",
    );
    expect(row.querySelector(".chat-author-avatar, button, a")).toBeNull();
  },
);

it.each([
  { snapshot: { senderLabel: "Jordan", text: "" }, name: "Jordan", unavailable: false },
  { snapshot: undefined, name: undefined, unavailable: true },
])(
  "names an oversized original only from its snapshot ($name)",
  ({ snapshot, name, unavailable }) => {
    // A named snapshot keeps the full line; without one the reserved row is never
    // left blank: it holds the anonymous unavailable placeholder.
    const { row } = draw(
      prompt,
      [
        {
          role: "assistant",
          content: "Answer",
          __openclaw: { replyToId: "large", ...(snapshot ? { replyToPreview: snapshot } : {}) },
        },
      ],
      false,
      "group",
      { ...turnSource, oversized: ["large"] },
    );
    expect(row?.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
    expect(row?.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
      unavailable ? "Original message unavailable" : undefined,
    );
    expect(Boolean(row?.querySelector(".chat-author-avatar, button, a"))).toBe(!unavailable);
    expect(container.querySelector(".chat-reply-attribution--pending")).toBeNull();
  },
);

it.each([
  { presentation: "group" as const, snapshotIndex: 1 },
  { presentation: "frame" as const, snapshotIndex: 0 },
])(
  "keeps an available snapshot within a reply $presentation",
  ({ presentation, snapshotIndex }) => {
    const { row, onOpenReply } = draw(
      prompt,
      [0, 1].map((index) => ({
        role: "assistant",
        content: `Answer ${index}`,
        __openclaw: {
          replyToId: "deleted",
          ...(index === snapshotIndex
            ? { replyToPreview: { senderLabel: "Jordan", text: "Earlier question" } }
            : { replyToPreview: { senderLabel: "Name-only snapshot", text: "" } }),
        },
      })),
      false,
      presentation,
      turnSource,
    );
    expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
    expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
    // A named snapshot with text resolves the reference before its source loads.
    // The original is known but outside the loaded history: the name still navigates.
    row.querySelector<HTMLButtonElement>("button.chat-reply-attribution__target")!.click();
    expect(onOpenReply).toHaveBeenCalledWith("deleted");
  },
);

it.each(["group", "frame"] as const)(
  "navigates from a %s strip whose original was found outside the loaded history",
  (presentation) => {
    const older = {
      role: "user",
      content: "Earlier question",
      __openclaw: { id: "older", senderId: "jordan", senderName: "Jordan" },
    };
    const { row, onOpenReply } = draw(
      prompt,
      [{ role: "assistant", content: "Answer", __openclaw: { replyToId: "older" } }],
      false,
      presentation,
      { replyShared: true, fetched: { older } },
    );
    const target = row.querySelector<HTMLButtonElement>("button.chat-reply-attribution__target")!;
    expect(target.getAttribute("aria-label")).toBe("Replying to Jordan");
    expect(target.querySelector(".chat-author-avatar")).not.toBeNull();
    target.click();
    expect(onOpenReply).toHaveBeenCalledWith("older");
  },
);

it.each(["loaded", "fetched"] as const)(
  "names the author of a %s original that has no text and navigates to it",
  (location) => {
    const photo = {
      role: "user",
      content: [],
      __openclaw: {
        id: "photo",
        senderId: "mira",
        senderName: "Mira",
        senderIdentity: { type: "profile", id: "mira" },
      },
    };
    const { row, onOpenReply } = draw(
      prompt,
      [{ role: "assistant", content: "Nice photo", __openclaw: { replyToId: "photo" } }],
      true,
      "group",
      {
        replyShared: true,
        ...(location === "loaded"
          ? { sources: { photo: { message: photo, senderLabel: "Mira" } } }
          : { fetched: { photo } }),
      },
    );
    expect(row.classList.contains("chat-reply-attribution--pending")).toBe(false);
    expect(row.querySelector(".chat-reply-attribution__unavailable")).toBeNull();
    const target = row.querySelector<HTMLButtonElement>("button.chat-reply-attribution__target")!;
    expect(target.getAttribute("aria-label")).toBe("Replying to Mira");
    expect(target.querySelector(".chat-author-avatar")).not.toBeNull();
    target.click();
    expect(onOpenReply).toHaveBeenCalledWith("photo");
  },
);

it.each([
  { promptRun: undefined, name: undefined },
  { promptRun: "run-a", name: undefined },
  { promptRun: "run-b", name: "Alice" },
])(
  "settles a 1:1 reply to a paged-out prompt by run ownership, not its snapshot (run $promptRun)",
  ({ promptRun, name }) => {
    const paged = {
      role: "user",
      content: "Deploy?",
      __openclaw: { id: "p1", senderName: "Alice", idempotencyKey: `${promptRun}:user` },
    };
    const { row } = draw(
      prompt,
      [
        {
          role: "assistant",
          content: "Deploying",
          __openclaw: {
            replyToId: "p1",
            replyToPreview: { senderLabel: "Alice", text: "Deploy?" },
          },
        },
      ],
      false,
      "group",
      {
        runId: "run-a",
        replyToSender: undefined,
        replyToMessage: undefined,
        ...(promptRun ? { fetched: { p1: paged } } : { pending: ["p1"] }),
      },
    );
    // Its own turn's prompt is hidden, so the row is not reserved while the lookup runs.
    expect(row?.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
    expect(container.querySelector(".chat-reply-attribution--pending")).toBeNull();
  },
);

it("hides a 1:1 reply to a paged-out original with no author or run", () => {
  draw(
    prompt,
    [{ role: "assistant", content: "Deploying", __openclaw: { replyToId: "p1" } }],
    false,
    "group",
    {
      runId: "run-a",
      replyToSender: undefined,
      replyToMessage: undefined,
      fetched: { p1: { role: "user", content: "Deploy?", __openclaw: { id: "p1" } } },
    },
  );
  expect(container.querySelector(".chat-reply-attribution")).toBeNull();
});

it.each([
  { shared: false, location: "fetched", snapshot: undefined, name: "Message" },
  { shared: true, location: "fetched", snapshot: undefined, name: undefined },
  { shared: true, location: "loaded", snapshot: undefined, name: undefined },
  {
    shared: true,
    location: "fetched",
    snapshot: { senderLabel: "Jordan", text: "" },
    name: "Jordan",
  },
] as const)(
  "names a $location original without sender provenance only when it cannot be a guess (shared $shared)",
  ({ shared, location, snapshot, name }) => {
    const unattributed = { role: "user", content: "Earlier question", __openclaw: { id: "older" } };
    const { row } = draw(
      prompt,
      [
        {
          role: "assistant",
          content: "Answer",
          __openclaw: { replyToId: "older", ...(snapshot ? { replyToPreview: snapshot } : {}) },
        },
      ],
      true,
      "group",
      {
        replyShared: shared || undefined,
        replyTurnSource: { key: "prompt-render-key", message: prompt },
        ...(location === "loaded"
          ? { sources: { older: { message: unattributed, senderLabel: "Message" } } }
          : { fetched: { older: unattributed } }),
      },
    );
    // A 1:1 thread keeps the neutral label; a shared thread never falls back to it.
    expect(row?.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
    expect(container.querySelector(".chat-reply-attribution--pending")).toBeNull();
  },
);

it("does not resolve a shared reply_to_current to a prompt without sender provenance", () => {
  const unattributed = { role: "user", content: "Question", __openclaw: { id: "current" } };
  draw(
    prompt,
    [{ role: "assistant", content: "Answer", openclawDelivery: { replyToCurrent: true } }],
    true,
    "group",
    {
      replyShared: true,
      replyCurrentSource: { key: "current-render-key", message: unattributed },
      sources: { current: { message: unattributed, senderLabel: "Message" } },
    },
  );
  expect(container.querySelector(".chat-reply-attribution")).toBeNull();
});

it.each([
  { finalTarget: "prompt", recipient: "Alice" },
  { finalTarget: "current-prompt", recipient: "Bob" },
  { finalTarget: "current", recipient: "Bob" },
])(
  "renders only the selected attribution when a frame's final response targets $recipient",
  ({ finalTarget, recipient }) => {
    const currentPrompt = {
      role: "user",
      content: "Bob's current question",
      __openclaw: { id: "current-prompt", senderId: "bob", senderName: "Bob" },
    };
    const current = { openclawDelivery: { replyToCurrent: true } };
    const explicit = (id: string) => ({ __openclaw: { replyToId: id } });
    const bob = { key: "current-prompt-render-key", message: currentPrompt };
    draw(
      prompt,
      [
        {
          role: "assistant",
          content: "Working on the current question",
          ...(finalTarget === "current" ? explicit("prompt") : current),
        },
        {
          role: "assistant",
          content: "Final answer",
          ...(finalTarget === "current" ? current : explicit(finalTarget)),
        },
      ],
      true,
      "frame",
      {
        runId: "run",
        replyToSender: { id: "bob", name: "Bob" },
        replyToMessage: bob,
        replyCurrentSource: bob,
        sources: { "current-prompt": { message: currentPrompt, senderLabel: "Bob" } },
      },
    );
    expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(1);
    expect(container.querySelector(".chat-reply-attribution__name")?.textContent).toBe(recipient);
    expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
  },
);

it.each([
  { finalReplies: false, name: undefined },
  { finalReplies: true, name: "Jordan" },
])(
  "attributes a frame only through its final answer's target (final replies $finalReplies)",
  ({ finalReplies, name }) => {
    const older = {
      role: "user",
      content: "Earlier question",
      __openclaw: { id: "older", senderId: "jordan", senderName: "Jordan" },
    };
    const replyToOlder = { __openclaw: { replyToId: "older" } };
    draw(
      prompt,
      [
        { role: "assistant", content: "Intermediate answer", ...replyToOlder },
        { role: "assistant", content: "Final answer", ...(finalReplies ? replyToOlder : {}) },
      ],
      true,
      "frame",
      {
        replyShared: true,
        replyToSender: undefined,
        replyToMessage: undefined,
        sources: { older: { message: older, senderLabel: "Jordan" } },
      },
    );
    expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(name ? 1 : 0);
    expect(container.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
  },
);

it("preserves the resolved display label when sender metadata contains only an ID", () => {
  const { row } = draw(
    { ...prompt, senderLabel: "Alice", __openclaw: { id: "prompt", senderId: "user-123" } },
    [{ role: "assistant", content: "Answer", __openclaw: { replyToId: "prompt" } }],
  );
  expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Alice");
  expect(row.querySelector(".chat-author-avatar")?.getAttribute("aria-label")).toBe("Alice");
});

it("keeps pending prompts without a persisted ID noninteractive", () => {
  const { row } = draw({ role: "user", content: "Pending question" });
  expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Alice");
  expect(row.querySelector("button, a")).toBeNull();
});

it("renders an automatic recipient without claiming a textless source is unavailable", () => {
  const { row } = draw(null);
  expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Alice");
  // The decorative mobile icon adds no text to the visible label.
  const label = row.querySelector(".chat-reply-attribution__label")!;
  expect(label.textContent?.trim()).toBe("Replying to");
  expect(
    label.querySelector(".chat-reply-attribution__mobile-icon")?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(row.querySelector(".chat-reply-attribution__unavailable")).toBeNull();
  expect(row.querySelector("button, a")).toBeNull();
  expect(row.nextElementSibling?.classList.contains("chat-bubble")).toBe(true);
});

it.each([
  {
    role: "assistant",
    identity: { type: "agent", id: "main" },
    name: "OpenClaw",
    label: "OpenClaw",
  },
  { role: "user", identity: { type: "profile", id: "alice" }, name: "Alice", label: "You" },
  { role: "user", identity: { type: "profile", id: "jordan" }, name: "Jordan", label: "Jordan" },
] as const)(
  "renders an inline reply to $label through the source identity owner",
  ({ role, identity, name, label }) => {
    container = document.body.appendChild(document.createElement("div"));
    const source = {
      role,
      content: "The original answer",
      __openclaw: {
        id: "inline-source",
        senderIdentity: identity,
        senderId: identity.id,
        senderName: name,
      },
    };
    const resolveReplyPreview = createReplyPreviewResolver(
      new Map([
        ["inline-source", { message: source, messageId: "inline-source", senderLabel: name }],
      ]),
      { assistantName: "OpenClaw", userId: "alice", userName: "Alice" },
    );
    const onOpenReply = vi.fn();
    render(
      renderMessageGroup(
        {
          kind: "group",
          key: "inline-user",
          role: "user",
          timestamp: 1,
          isStreaming: false,
          visibleContent: "text",
          sender: { id: "alice", name: "Alice", identity: { type: "profile", id: "alice" } },
          messages: [
            {
              key: "inline-user",
              hasVisibleContent: true,
              message: {
                role: "user",
                content: "Follow up",
                __openclaw: { id: "inline-user", replyToId: "inline-source" },
              },
            },
          ],
        },
        {
          showReasoning: false,
          showToolCalls: false,
          userId: "alice",
          resolveReplyPreview,
          onOpenReply,
        },
      ),
      container,
    );
    const row = container.querySelector<HTMLButtonElement>(
      ".chat-bubble > .chat-reply-attribution--inline .chat-reply-attribution__target",
    )!;
    expect(row.getAttribute("aria-label")).toBe(`Replying to ${label}`);
    expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe(label);
    expect(row.querySelector(".chat-author-avatar")).not.toBeNull();
    expect(Boolean(row.querySelector(".identity-avatar--agent"))).toBe(role === "assistant");
    expect(container.querySelector(".chat-reply-connector")).toBeNull();
    const labelElement = container.querySelector<HTMLElement>(".chat-reply-attribution__label")!;
    expect(row.contains(labelElement)).toBe(false);
    labelElement.click();
    expect(onOpenReply).not.toHaveBeenCalled();
    row.click();
    expect(onOpenReply).toHaveBeenCalledWith("inline-source");
  },
);

function drawOwnReply(
  original: Record<string, unknown>,
  shared: boolean,
  snapshot?: { senderLabel: string; text: string },
) {
  container = document.body.appendChild(document.createElement("div"));
  const resolveReplyPreview = createReplyPreviewResolver(new Map(), {
    assistantName: "OpenClaw",
    userId: "alice",
    replyMessageAccess: {
      read: (id) => (id === "older" ? original : undefined),
    },
  });
  render(
    renderMessageGroup(
      {
        kind: "group",
        key: "own-reply",
        role: "user",
        timestamp: 1,
        isStreaming: false,
        visibleContent: "text",
        sender: { id: "alice", name: "Alice", identity: { type: "profile", id: "alice" } },
        ...(shared ? { replyShared: true } : {}),
        messages: [
          {
            key: "own-reply",
            hasVisibleContent: true,
            message: {
              role: "user",
              content: "Follow up",
              __openclaw: {
                id: "own-reply",
                replyToId: "older",
                ...(snapshot ? { replyToPreview: snapshot } : {}),
              },
            },
          },
        ],
      },
      { showReasoning: false, showToolCalls: false, userId: "alice", resolveReplyPreview },
    ),
    container,
  );
  return container.querySelector(".chat-bubble > .chat-reply-attribution--inline");
}

it.each([
  { shared: false, snapshot: undefined, name: "Message" },
  { shared: true, snapshot: undefined, name: undefined },
  { shared: true, snapshot: { senderLabel: "Jordan", text: "" }, name: "Jordan" },
] as const)(
  "names a fetched original without sender provenance in an own reply only when it cannot be a guess (shared $shared)",
  ({ shared, snapshot, name }) => {
    const strip = drawOwnReply(
      { role: "user", content: "Earlier question", __openclaw: { id: "older" } },
      shared,
      snapshot,
    );
    // A 1:1 thread keeps the neutral label; a shared thread never falls back to it.
    expect(strip?.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
    expect(container.querySelector(".chat-reply-attribution--pending")).toBeNull();
  },
);

it.each([
  {
    sender: { senderId: "jordan@example.com" },
    label: undefined,
    snapshot: "Jordan",
    name: "Jordan",
  },
  {
    sender: { senderId: "jordan@example.com", senderName: "Jordan Lee" },
    label: undefined,
    snapshot: "Jordan",
    name: "Jordan Lee",
  },
  {
    sender: { senderId: "jordan@example.com" },
    label: "Jordan Lee",
    snapshot: "Jordan",
    name: "Jordan Lee",
  },
  {
    sender: { senderId: "jordan@example.com" },
    label: undefined,
    snapshot: undefined,
    name: "jordan",
  },
] as const)(
  "keeps a shared snapshot's name when the fetched sender has only an id ($name, label $label)",
  ({ sender, label, snapshot, name }) => {
    const strip = drawOwnReply(
      {
        role: "user",
        content: "Earlier question",
        ...(label ? { senderLabel: label } : {}),
        __openclaw: { id: "older", ...sender },
      },
      true,
      snapshot ? { senderLabel: snapshot, text: "" } : undefined,
    );
    // The fetched original's own name or display label wins; an id-only sender
    // keeps the snapshot's name, and only then its formatted id.
    expect(strip?.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
  },
);
