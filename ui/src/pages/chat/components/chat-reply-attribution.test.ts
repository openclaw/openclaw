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
) {
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
    { assistantName: "Assistant" },
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

describe("reply attribution excerpt", () => {
  it.each([
    [
      "123456789012345678901234567890123456789012345",
      "123456789012345678901234567890123456789012345",
    ],
    ["Short prompt", "Short prompt"],
    [
      "\n  # **Review** [the plan](https://example.test) and `notes`\nDo not quote this line",
      "Review the plan and notes",
    ],
    ["  Several    spaces\tbetween words ", "Several spaces between words"],
    ["```typescript\nconst value = 1;\n```\nLater question", "const value = 1;"],
    ["👩🏽‍💻".repeat(41), "👩🏽‍💻".repeat(41)],
    ["", ""],
  ])("preserves the first useful plain-text line for CSS truncation of %j", (input, expected) => {
    const { row } = draw({ ...prompt, content: input });
    const excerpt = row.querySelector(".chat-reply-attribution__excerpt");
    expect(excerpt?.textContent?.trim() ?? "").toBe(expected);
  });
});

it("renders one recipient and excerpt per group, suppresses duplicate name and navigates by persisted ID", () => {
  const { row, onOpenReply } = draw(prompt, [
    { role: "assistant", content: "First answer" },
    { role: "assistant", content: "Second answer", __openclaw: { replyToId: "prompt" } },
  ]);
  expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(1);
  expect(container.querySelector(".chat-sender-name")).toBeNull();
  expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
  expect(row.querySelector(".chat-author-avatar")).not.toBeNull();
  const excerpt = row.querySelector<HTMLButtonElement>("button")!;
  expect(excerpt.textContent).toContain("Original question");
  excerpt.click();
  expect(onOpenReply).toHaveBeenCalledWith("prompt");
});

it("renders a file icon and unquoted filename for an attachment-only prompt", () => {
  const source = {
    ...prompt,
    content: [
      {
        type: "attachment",
        attachment: {
          kind: "document",
          url: "https://files.example.test/release-plan.pdf",
          label: "release-plan.pdf",
          mimeType: "application/pdf",
        },
      },
    ],
  };
  const { row } = draw(source);
  expect(row.querySelector(".chat-reply-attribution__excerpt")?.textContent?.trim()).toBe(
    "release-plan.pdf",
  );
  expect(row.querySelector(".chat-reply-attribution__file svg")).not.toBeNull();
});

it("keeps an unavailable explicit source's snapshot without linking or inferring the latest participant", () => {
  const { row } = draw(
    prompt,
    [
      {
        role: "assistant",
        content: "Answer",
        __openclaw: {
          replyToId: "deleted",
          replyToPreview: { senderLabel: "Jordan", text: "Earlier question" },
        },
      },
    ],
    false,
  );
  expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
  expect(row.querySelector(".chat-reply-attribution__excerpt")?.textContent).toContain(
    "Earlier question",
  );
  expect(row.querySelector("button, a")).toBeNull();
  expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
});

it("keeps an unavailable reference without a recipient snapshot noninteractive", () => {
  const { row } = draw(
    prompt,
    [{ role: "assistant", content: "Answer", __openclaw: { replyToId: "deleted" } }],
    false,
  );
  expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("message");
  expect(row.querySelector("button, a")).toBeNull();
  expect(container.querySelector(".chat-reply-attribution--inline")).toBeNull();
});

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
    );
    expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
    expect(row.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
      "Original message unavailable",
    );
    expect(row.querySelector("button, a")).toBeNull();
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
    expect(row.querySelector(".chat-reply-attribution__excerpt")?.textContent).toContain(
      "Earlier question",
    );
    expect(row.querySelector("button, a")).toBeNull();
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
  expect(row.querySelector(".chat-reply-attribution__excerpt")?.textContent).toContain(
    "Pending question",
  );
  expect(row.querySelector("button, a")).toBeNull();
});

it.each([
  { finalTarget: "prompt", recipient: "Alice", remainingPreviews: 0 },
  { finalTarget: "current-prompt", recipient: "Bob", remainingPreviews: 0 },
  { finalTarget: "current", recipient: "Bob", remainingPreviews: 0 },
])(
  "renders only the selected attribution when a frame's final response targets $recipient",
  ({ finalTarget, recipient, remainingPreviews }) => {
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
    expect(container.querySelectorAll(".chat-reply-attribution--inline")).toHaveLength(
      remainingPreviews,
    );
  },
);

it("renders an unquoted unavailable label when the source text is unavailable", () => {
  const { row } = draw(null);
  expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Alice");
  // The decorative strokeIcon shell contributes whitespace, not visible copy.
  const label = row.querySelector(".chat-reply-attribution__label")!;
  expect(label.textContent?.trim()).toBe("Replying to");
  expect(
    label.querySelector(".chat-reply-attribution__mobile-icon")?.getAttribute("aria-hidden"),
  ).toBe("true");
  expect(row.querySelector(".chat-reply-attribution__excerpt")).toBeNull();
  expect(row.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
    "Original message unavailable",
  );
  expect(row.querySelector("button, a")).toBeNull();
  expect(row.nextElementSibling?.classList.contains("chat-bubble")).toBe(true);
});

it("preserves a name-only snapshot while requesting its missing source", () => {
  const { row, onResolveReply } = draw(
    prompt,
    [
      {
        role: "assistant",
        content: "Answer",
        __openclaw: {
          replyToId: "deleted",
          replyToPreview: { senderLabel: "Jordan", text: "" },
        },
      },
    ],
    false,
  );
  expect(row.querySelector(".chat-reply-attribution__name")?.textContent).toBe("Jordan");
  expect(row.querySelector(".chat-reply-attribution__unavailable")?.textContent).toBe(
    "Original message unavailable",
  );
  expect(row.querySelector("button, a")).toBeNull();
  expect(onResolveReply).toHaveBeenCalledWith("deleted");
});

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
  expect(container.querySelector(".chat-reply-attribution__name")?.textContent).toContain(
    preview ? "Jordan" : "message",
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
    expect(row.querySelector(".chat-reply-attribution__excerpt[title]")).toBeNull();
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
