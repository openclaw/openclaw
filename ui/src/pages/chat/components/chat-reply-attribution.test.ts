/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  context: Partial<MessageGroup> & { missing?: string[] } = {},
) {
  const { missing = [], ...groupContext } = context;
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
  const onResolveReply = vi.fn();
  const resolveReplyPreview = createReplyPreviewResolver(
    new Map(
      loaded
        ? [["prompt", { message: source, messageId: "prompt-render-key", senderLabel: "Alice" }]]
        : [],
    ),
    {
      assistantName: "Assistant",
      replyMessageAccess: { read: () => undefined, missing: (id) => missing.includes(id) },
    },
  );
  const options = {
    showReasoning: false,
    showToolCalls: false,
    avatarPlacement: "none" as const,
    onOpenReply,
    onResolveReply,
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
    onResolveReply,
    row: container.querySelector<HTMLElement>(".chat-reply-attribution--reply")!,
  };
}

it("renders one recipient per group, suppresses duplicate name and navigates from the name by persisted ID", () => {
  const { row, onOpenReply } = draw(prompt, [
    { role: "assistant", content: "First answer" },
    { role: "assistant", content: "Second answer", __openclaw: { replyToId: "prompt" } },
  ]);
  expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(1);
  expect(container.querySelector(".chat-sender-name")).toBeNull();
  expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
  expect(row.querySelector(".chat-author-avatar")).not.toBeNull();
  expect(row.textContent).not.toContain("Original question");
  const target = row.querySelector<HTMLButtonElement>("button")!;
  expect(target.getAttribute("aria-label")).toBe("Replying to Alice");
  expect(target.querySelector(".chat-author-avatar")).not.toBeNull();
  expect(target.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Alice");
  target.click();
  expect(onOpenReply).toHaveBeenCalledWith("prompt");
});

it.each([
  { snapshot: undefined, missing: [] },
  { snapshot: { senderLabel: "Jordan", text: "" }, missing: [] },
  { snapshot: undefined, missing: ["deleted"] },
  { snapshot: { senderLabel: "", text: "Earlier question" }, missing: ["deleted"] },
])(
  "renders no strip for an unresolved or anonymous missing reference %o",
  ({ snapshot, missing }) => {
    const { onResolveReply } = draw(
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
    expect(onResolveReply).toHaveBeenCalledTimes(missing.length ? 0 : 1);
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
      { missing: ["deleted"] },
    );
    expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
    expect(row.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
      "Original message unavailable",
    );
    expect(row.querySelector(".chat-author-avatar, button, a")).toBeNull();
  },
);

it.each([
  { presentation: "group" as const, snapshotIndex: 1 },
  { presentation: "frame" as const, snapshotIndex: 0 },
])(
  "keeps an available snapshot within a reply $presentation",
  ({ presentation, snapshotIndex }) => {
    const { row } = draw(
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
    );
    expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
    expect(row.querySelector("button, a")).toBeNull();
    expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
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

it.each([
  { finalTarget: "prompt", recipient: "Alice" },
  { finalTarget: "current-prompt", recipient: "Bob" },
  { finalTarget: "current", recipient: "Bob" },
])(
  "renders only the selected attribution when a frame's final response targets $recipient",
  ({ finalTarget, recipient }) => {
    container = document.body.appendChild(document.createElement("div"));
    const currentPrompt = {
      role: "user",
      content: "Bob's current question",
      __openclaw: { id: "current-prompt", senderId: "bob", senderName: "Bob" },
    };
    const commentary: MessageGroup = {
      kind: "group",
      key: "commentary",
      role: "assistant",
      timestamp: 1,
      isStreaming: false,
      visibleContent: "text",
      runId: "run",
      replyToSender: { id: "bob", name: "Bob" },
      replyToMessage: { key: "current-prompt-render", message: currentPrompt },
      messages: [
        {
          key: "commentary-message",
          hasVisibleContent: true,
          message: {
            role: "assistant",
            content: "Working on the current question",
            ...(finalTarget === "current"
              ? { __openclaw: { replyToId: "prompt" } }
              : { openclawDelivery: { replyToCurrent: true } }),
          },
        },
      ],
    };
    const finalEntry = {
      key: "final-message",
      hasVisibleContent: true,
      message: {
        role: "assistant",
        content: "Final answer",
        ...(finalTarget === "current"
          ? { openclawDelivery: { replyToCurrent: true } }
          : { __openclaw: { replyToId: finalTarget } }),
      },
    };
    const resolveReplyPreview = createReplyPreviewResolver(
      new Map([
        ["prompt", { message: prompt, messageId: "prompt-render", senderLabel: "Alice" }],
        [
          "current-prompt",
          { message: currentPrompt, messageId: "current-prompt-render", senderLabel: "Bob" },
        ],
      ]),
      { assistantName: "Assistant" },
    );
    render(
      renderAgentRunFrame(
        {
          kind: "agent-run-frame",
          key: "frame",
          runId: "run",
          boundaryId: "current-prompt",
          outcome: { kind: "completed", actionOwner: finalEntry },
          parts: [commentary, { ...commentary, key: "final", messages: [finalEntry] }],
        },
        {
          streamOptions: {},
          renderGroupOptions: () => ({
            showReasoning: false,
            showToolCalls: false,
            avatarPlacement: "none",
            resolveReplyPreview,
          }),
          isWorkExpanded: () => false,
          onToggleWork: () => undefined,
        },
      ),
      container,
    );
    expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(1);
    expect(container.querySelector(".chat-reply-attribution__name")?.textContent).toBe(recipient);
    expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
  },
);

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
  { case: "unresolved", source: undefined, turnSource: false, strip: false },
  { case: "resolved to its own prompt", source: "prompt", turnSource: true, strip: false },
  { case: "resolved to an older prompt", source: "prompt", turnSource: false, strip: true },
])(
  "renders a 1:1 reply_to_current $case without guessing an origin",
  ({ source, turnSource, strip }) => {
    const prompted = { key: "prompt-render-key", message: prompt };
    draw(
      prompt,
      [{ role: "assistant", content: "Tô aqui", openclawDelivery: { replyToCurrent: true } }],
      true,
      "group",
      {
        replyToSender: undefined,
        replyToMessage: undefined,
        ...(source ? { replyCurrentSource: prompted } : {}),
        replyTurnSource: turnSource ? prompted : { key: "later", message: {} },
      },
    );
    expect(container.textContent).not.toContain("current message");
    expect(container.textContent).not.toContain("Original message unavailable");
    expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
    const row = container.querySelector(".chat-reply-attribution--reply");
    expect(Boolean(row)).toBe(strip);
    if (row) {
      expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Alice");
      expect(row.querySelector("button")?.textContent).toContain("Alice");
    }
  },
);

it.each([
  { target: "prompt", shared: false, strip: false },
  { target: "prompt", shared: true, strip: true },
  { target: "older", shared: false, strip: true },
])(
  "renders an explicit reply to $target (shared: $shared) only when it adds context",
  ({ target, shared, strip }) => {
    const older = {
      ...prompt,
      __openclaw: { id: "older", senderId: "alice", senderName: "Alice" },
    };
    container = document.body.appendChild(document.createElement("div"));
    const resolveReplyPreview = createReplyPreviewResolver(
      new Map([
        ["prompt", { message: prompt, messageId: "prompt-render", senderLabel: "Alice" }],
        ["older", { message: older, messageId: "older-render", senderLabel: "Alice" }],
      ]),
      { assistantName: "Assistant" },
    );
    render(
      renderMessageGroup(
        {
          kind: "group",
          key: "answer",
          role: "assistant",
          timestamp: 1,
          isStreaming: false,
          visibleContent: "text",
          ...(shared ? { replyShared: true } : {}),
          replyTurnSource: { key: "prompt-render", message: prompt },
          messages: [
            {
              key: "answer-0",
              hasVisibleContent: true,
              message: { role: "assistant", content: "Answer", __openclaw: { replyToId: target } },
            },
          ],
        },
        {
          showReasoning: false,
          showToolCalls: false,
          avatarPlacement: "none",
          resolveReplyPreview,
        },
      ),
      container,
    );
    expect(container.querySelectorAll(".chat-reply-attribution")).toHaveLength(strip ? 1 : 0);
  },
);

it.each([
  { preview: undefined, requests: 1 },
  { preview: { senderLabel: "Jordan", text: "" }, requests: 1 },
  { preview: { senderLabel: "Jordan", text: "Earlier question" }, requests: 0 },
])("resolves inline reply content only when missing: $preview", ({ preview, requests }) => {
  container = document.body.appendChild(document.createElement("div"));
  const onResolveReply = vi.fn();
  render(
    renderMessageGroup(
      {
        kind: "group",
        key: "follow-up-group",
        role: "user",
        timestamp: 1,
        isStreaming: false,
        visibleContent: "text",
        messages: [
          {
            key: "follow-up",
            hasVisibleContent: true,
            message: {
              role: "user",
              content: "A follow-up.",
              __openclaw: { id: "follow-up", replyToId: "original", replyToPreview: preview },
            },
          },
        ],
      },
      { showReasoning: false, showToolCalls: false, avatarPlacement: "none", onResolveReply },
    ),
    container,
  );
  // Only snapshot text resolves the reference before its source loads.
  expect(container.querySelector(".chat-reply-attribution__name")?.textContent).toBe(
    preview?.text ? "Jordan" : undefined,
  );
  expect(onResolveReply).toHaveBeenCalledTimes(requests);
  if (requests) {
    expect(onResolveReply).toHaveBeenCalledWith("original");
  }
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
    expect(row).toBeInstanceOf(HTMLButtonElement);
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
