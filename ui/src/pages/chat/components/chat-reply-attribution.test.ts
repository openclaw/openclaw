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

type Snapshot = { senderLabel: string; text: string };
const jordanSnapshot: Snapshot = { senderLabel: "Jordan", text: "" };

it.each([
  { status: undefined, snapshot: undefined, reserve: false },
  { status: undefined, snapshot: { ...jordanSnapshot, text: "Earlier question" }, reserve: false },
  { status: "missing", snapshot: jordanSnapshot, reserve: false },
  { status: "pending", snapshot: undefined, reserve: true },
  { status: "missing", snapshot: undefined, reserve: true },
  { status: "missing", snapshot: jordanSnapshot, reserve: true },
  { status: "oversized", snapshot: jordanSnapshot, reserve: true },
  { status: "oversized", snapshot: undefined, reserve: true },
] as const)(
  "settles a $status lookup with reserved row $reserve and snapshot $snapshot",
  ({ status, snapshot, reserve }) => {
    const { row } = draw(prompt, [reply("deleted", snapshot)], false, "group", {
      ...(reserve ? (status === "oversized" ? turnSource : { replyShared: true }) : {}),
      ...(status ? { [status]: ["deleted"] } : {}),
    });
    if (!reserve) {
      expect(container.querySelector(".chat-reply-attribution")).toBeNull();
      expect(container.textContent).not.toContain("Original message unavailable");
      return;
    }
    const unavailable = status === "missing" || (status === "oversized" && !snapshot);
    const name = snapshot?.senderLabel;
    expect(row.classList.contains("chat-reply-attribution--pending")).toBe(status === "pending");
    expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
    expect(Boolean(row.querySelector(".chat-reply-attribution__person"))).toBe(Boolean(name));
    expect(row.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
      unavailable ? "Original message unavailable" : undefined,
    );
    expect(Boolean(row.querySelector(".chat-author-avatar, button, a"))).toBe(
      status === "oversized" && !unavailable,
    );
  },
);

it.each([
  { presentation: "group", shared: true, snapshotIndex: 0, text: "", settle: true },
  { presentation: "group", shared: false, snapshotIndex: 0, text: "", settle: true },
  { presentation: "frame", shared: false, snapshotIndex: 0, text: "", settle: true },
  { presentation: "group", shared: false, snapshotIndex: 1, text: "", settle: false },
  { presentation: "frame", shared: false, snapshotIndex: 1, text: "", settle: false },
  {
    presentation: "group",
    shared: false,
    snapshotIndex: 1,
    text: "Earlier question",
    settle: false,
  },
  {
    presentation: "frame",
    shared: false,
    snapshotIndex: 0,
    text: "Earlier question",
    settle: false,
  },
] as const)(
  "selects and settles the strongest snapshot in a $presentation ($shared, $snapshotIndex, $text, $settle)",
  ({ presentation, shared, snapshotIndex, text, settle }) => {
    const replies = [0, 1].map((index) =>
      reply(
        "older",
        index === snapshotIndex
          ? { ...jordanSnapshot, text }
          : text
            ? { senderLabel: "Name-only snapshot", text: "" }
            : undefined,
      ),
    );
    for (const lookup of settle ? ["pending", "missing"] : [text ? "pending" : "missing"]) {
      const { row, onOpenReply } = draw(prompt, replies, false, presentation, {
        ...turnSource,
        replyShared: shared || undefined,
        [lookup]: ["older"],
      });
      expect(row.classList.contains("chat-reply-attribution--pending")).toBe(false);
      expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
      if (lookup === "missing") {
        expect(row.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
          "Original message unavailable",
        );
        expect(row.querySelector(".chat-author-avatar, button, a")).toBeNull();
      } else {
        expect(row.querySelector(".chat-author-avatar")).not.toBeNull();
        expect(row.querySelector(".chat-reply-attribution__unavailable")).toBeNull();
        expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
        row.querySelector<HTMLButtonElement>("button.chat-reply-attribution__target")!.click();
        expect(onOpenReply).toHaveBeenCalledWith("older");
      }
      render(null, container);
      container.remove();
    }
  },
);

function reply(id: string, snapshot?: Snapshot) {
  return {
    role: "assistant",
    content: "Answer",
    __openclaw: { replyToId: id, replyToPreview: snapshot },
  };
}

it.each([
  { presentation: "group", location: "fetched", text: "Earlier question", name: "Jordan" },
  { presentation: "frame", location: "fetched", text: "Earlier question", name: "Jordan" },
  { presentation: "group", location: "loaded", text: [], name: "Mira" },
  { presentation: "group", location: "fetched", text: [], name: "Mira" },
] as const)(
  "navigates to the $location original from a $presentation ($name)",
  ({ presentation, location, text, name }) => {
    const id = name === "Mira" ? "photo" : "older";
    const original = {
      role: "user",
      content: text,
      __openclaw: {
        id,
        senderId: name.toLowerCase(),
        senderName: name,
        ...(name === "Mira" ? { senderIdentity: { type: "profile", id: "mira" } } : {}),
      },
    };
    const { row, onOpenReply } = draw(prompt, [reply(id)], location === "loaded", presentation, {
      replyShared: true,
      ...(location === "loaded"
        ? { sources: { [id]: { message: original, senderLabel: name } } }
        : { fetched: { [id]: original } }),
    });
    expect(row.classList.contains("chat-reply-attribution--pending")).toBe(false);
    expect(row.querySelector(".chat-reply-attribution__unavailable")).toBeNull();
    const target = row.querySelector<HTMLButtonElement>("button.chat-reply-attribution__target")!;
    expect(target.getAttribute("aria-label")).toBe(`Replying to ${name}`);
    expect(target.querySelector(".chat-author-avatar")).not.toBeNull();
    target.click();
    expect(onOpenReply).toHaveBeenCalledWith(id);
  },
);

it.each([
  { promptRun: undefined, name: undefined, anonymous: false },
  { promptRun: undefined, name: undefined, anonymous: true },
  { promptRun: "run-a", name: undefined, anonymous: false },
  { promptRun: "run-b", name: "Alice", anonymous: false },
])(
  "settles a 1:1 reply to a paged-out prompt by run ownership, not its snapshot (run $promptRun)",
  ({ promptRun, name, anonymous }) => {
    const paged = {
      role: "user",
      content: "Deploy?",
      __openclaw: {
        id: "p1",
        ...(anonymous ? {} : { senderName: "Alice", idempotencyKey: `${promptRun}:user` }),
      },
    };
    const { row } = draw(
      prompt,
      [
        {
          role: "assistant",
          content: "Deploying",
          __openclaw: {
            replyToId: "p1",
            replyToPreview: anonymous ? undefined : { senderLabel: "Alice", text: "Deploy?" },
          },
        },
      ],
      false,
      "group",
      {
        runId: "run-a",
        replyToSender: undefined,
        replyToMessage: undefined,
        ...(promptRun || anonymous ? { fetched: { p1: paged } } : { pending: ["p1"] }),
      },
    );
    if (anonymous) {
      expect(container.querySelector(".chat-reply-attribution")).toBeNull();
    }
    expect(row?.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
    expect(container.querySelector(".chat-reply-attribution--pending")).toBeNull();
  },
);

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
  { finalTarget: "older", recipient: "Jordan" },
  { finalTarget: undefined, recipient: undefined },
])(
  "attributes a frame only through the final answer's target ($finalTarget)",
  ({ finalTarget, recipient }) => {
    const currentPrompt = {
      role: "user",
      content: "Bob's current question",
      __openclaw: { id: "current-prompt", senderId: "bob", senderName: "Bob" },
    };
    const older = {
      role: "user",
      content: "Earlier question",
      __openclaw: { id: "older", senderId: "jordan", senderName: "Jordan" },
    };
    const current = {
      role: "assistant",
      content: "Answer",
      openclawDelivery: { replyToCurrent: true },
    };
    const bob = { key: "current-prompt-render-key", message: currentPrompt };
    const explicitOlder = finalTarget === "older" || !finalTarget;
    draw(
      prompt,
      [
        explicitOlder ? reply("older") : finalTarget === "current" ? reply("prompt") : current,
        finalTarget === "current"
          ? current
          : finalTarget
            ? reply(finalTarget)
            : { role: "assistant", content: "Final answer" },
      ],
      true,
      "frame",
      explicitOlder
        ? {
            replyShared: true,
            replyToSender: undefined,
            replyToMessage: undefined,
            sources: { older: { message: older, senderLabel: "Jordan" } },
          }
        : {
            runId: "run",
            replyToSender: { id: "bob", name: "Bob" },
            replyToMessage: bob,
            replyCurrentSource: bob,
            sources: { "current-prompt": { message: currentPrompt, senderLabel: "Bob" } },
          },
    );
    expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(
      recipient ? 1 : 0,
    );
    expect(container.querySelector(".chat-reply-attribution__name")?.textContent).toBe(recipient);
    expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
  },
);

it.each([
  {
    source: { ...prompt, senderLabel: "Alice", __openclaw: { id: "prompt", senderId: "user-123" } },
    explicit: true,
  },
  { source: { role: "user", content: "Pending question" }, explicit: false },
  { source: null, explicit: false },
])(
  "renders a known recipient with navigation only for persisted sources ($source)",
  ({ source, explicit }) => {
    const { row } = draw(source, explicit ? [reply("prompt")] : undefined);
    expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Alice");
    if (explicit) {
      expect(row.querySelector(".chat-author-avatar")?.getAttribute("aria-label")).toBe("Alice");
    } else {
      expect(row.querySelector("button, a")).toBeNull();
    }
    if (source === null) {
      const label = row.querySelector(".chat-reply-attribution__label")!;
      expect(label.textContent?.trim()).toBe("Replying to");
      expect(
        label.querySelector(".chat-reply-attribution__mobile-icon")?.getAttribute("aria-hidden"),
      ).toBe("true");
      expect(row.querySelector(".chat-reply-attribution__unavailable")).toBeNull();
      expect(row.nextElementSibling?.classList.contains("chat-bubble")).toBe(true);
    }
  },
);

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

type OwnReplyCase = {
  shared: boolean;
  sender?: { senderId: string; senderName?: string };
  label?: string;
  snapshot?: Snapshot;
  name?: string;
};
const ownReplyCases: OwnReplyCase[] = [
  { shared: false, name: "Message" },
  { shared: true },
  { shared: true, snapshot: jordanSnapshot, name: "Jordan" },
  {
    shared: true,
    sender: { senderId: "jordan@example.com" },
    snapshot: jordanSnapshot,
    name: "Jordan",
  },
  {
    shared: true,
    sender: { senderId: "jordan@example.com", senderName: "Jordan Lee" },
    snapshot: jordanSnapshot,
    name: "Jordan Lee",
  },
  {
    shared: true,
    sender: { senderId: "jordan@example.com" },
    label: "Jordan Lee",
    snapshot: jordanSnapshot,
    name: "Jordan Lee",
  },
  { shared: true, sender: { senderId: "jordan@example.com" }, name: "jordan" },
];
it.each(ownReplyCases)(
  "names a fetched own-reply source from provenance before its snapshot ($name, $label, $shared)",
  ({ shared, sender, label, snapshot, name }) => {
    const strip = drawOwnReply(
      {
        role: "user",
        content: "Earlier question",
        ...(label ? { senderLabel: label } : {}),
        __openclaw: { id: "older", ...sender },
      },
      shared,
      snapshot,
    );
    expect(strip?.querySelector(".chat-reply-attribution__name")?.textContent).toBe(name);
    expect(container.querySelector(".chat-reply-attribution--pending")).toBeNull();
  },
);
