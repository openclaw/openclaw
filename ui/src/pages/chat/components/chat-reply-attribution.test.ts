/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { AgentRunFrame } from "./chat-agent-run-frame.tsx";
import { MessageGroup as NativeMessageGroup } from "./chat-message-group-view.tsx";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";

const replyName = (root: ParentNode | null | undefined) =>
  root?.querySelector(".chat-reply-attribution__name")?.textContent;
const unavailableElement = (root: ParentNode) =>
  root.querySelector(".chat-reply-attribution__unavailable");
const find = <E extends Element = HTMLElement>(selector: string, root: ParentNode = container) =>
  root.querySelector<E>(selector);
const textMessage = (role: string, content: string, metadata: Record<string, unknown> = {}) => ({
  role,
  content,
  __openclaw: metadata,
});
const groupDefaults = {
  kind: "group" as const,
  role: "assistant",
  timestamp: 1,
  isStreaming: false,
  visibleContent: "text" as const,
};
const renderOptions = { showReasoning: false, showToolCalls: false };
type RenderOptions = Parameters<ReturnType<typeof createMessageGroupHarness>["render"]>[1];
function renderGroup(group: MessageGroup, options: RenderOptions) {
  container = document.body.appendChild(document.createElement("div"));
  const harness = createMessageGroupHarness(container);
  harness.render(group, { ...renderOptions, ...options });
  return harness;
}
function loadedPreview(id: string, message: unknown, senderLabel: string, userName?: string) {
  return createReplyPreviewResolver(
    new Map<string, LoadedReplySource>([[id, { message, messageId: id, senderLabel }]]),
    { assistantName: "OpenClaw", userId: "alice", userName },
  );
}
const entries = (messages: unknown[]) =>
  messages.map((message, index) => ({ message, key: `answer-${index}`, hasVisibleContent: true }));
const ownSender = {
  id: "alice",
  name: "Alice",
  identity: { type: "profile", id: "alice" },
} as const;
function ownReplyGroup(id: string, target: string, snapshot?: Snapshot): MessageGroup {
  return {
    ...groupDefaults,
    key: id,
    role: "user",
    sender: ownSender,
    messages: entries([
      textMessage("user", "Follow up", {
        id,
        replyToId: target,
        ...(snapshot ? { replyToPreview: snapshot } : {}),
      }),
    ]),
  };
}

const alice = { id: "alice", name: "Alice" };
const prompt = textMessage("user", "Original question", {
  id: "prompt",
  senderId: "alice",
  senderName: "Alice",
});
const currentReply = {
  role: "assistant",
  content: "Answer",
  openclawDelivery: { replyToCurrent: true },
};
// A 1:1 turn whose own prompt is loaded: a reference to anything else is older.
const turnSource = { replyTurnSource: { key: "prompt-render-key", message: prompt } };
let container: HTMLDivElement;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (container) {
    cleanupSolid();
    container.remove();
  }
});

it("redraws the reply connector from the current avatar after its presentation changes", async () => {
  const resizes: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizes.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const bounds = [
      ["chat-avatar-slot", [30, 50, 40, 40]],
      ["chat-avatar", [10, 30, 20, 20]],
      ["chat-reply-attribution", [100, 20, 60, 20]],
      ["chat-reply-attribution__label", [100, 20, 40, 20]],
    ] as const;
    const rect = bounds.find(([name]) => this.classList.contains(name))?.[1];
    return new DOMRect(...(rect ?? ([0, 0, 400, 200] as const)));
  });
  const group: MessageGroup = {
    ...groupDefaults,
    key: "connector",
    replyToSender: alice,
    replyToMessage: { key: "prompt", message: prompt },
    messages: entries([textMessage("assistant", "Answer")]),
  };
  const options = {
    avatarPlacement: "gutter" as const,
    ...renderOptions,
  };
  const harness = renderGroup(group, options);
  await waitForSolid(() => expect(find(".chat-reply-connector path")).not.toBeNull());
  for (const resize of resizes) {
    resize();
  }
  const path = find(".chat-reply-connector path")!;
  expect(path.getAttribute("d")).toMatch(/^M 20 30 /);

  harness.render(group, { ...options, assistantAvatar: "blob:reply-avatar" });
  await waitForSolid(() => expect(find(".chat-group > .chat-avatar-slot")).not.toBeNull());
  for (const resize of resizes) {
    resize();
  }
  expect(find(".chat-reply-connector path")).toBe(path);
  expect(path.getAttribute("d")).toMatch(/^M 50 50 /);
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
    ...groupDefaults,
    key: "answer-group",
    senderLabel: "Alice",
    replyToSender: alice,
    replyToMessage: { key: "prompt-render-key", message: source },
    ...groupContext,
    messages: entries(replies),
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
    ...renderOptions,
    avatarPlacement: "none" as const,
    onOpenReply,
    resolveReplyPreview,
  };
  mountSolid(
    () =>
      presentation === "frame"
        ? createComponent(AgentRunFrame, {
            frame: {
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
            options: {
              streamOptions: {},
              renderGroupOptions: () => options,
              isWorkExpanded: () => false,
              onToggleWork: () => undefined,
            },
          })
        : createComponent(NativeMessageGroup, { group, options }),
    { container },
  );
  return {
    onOpenReply,
    row: find(".chat-reply-attribution--reply")!,
  };
}

it("renders one recipient per group and navigates from the name by persisted ID", () => {
  const { row, onOpenReply } = draw(prompt, [
    { role: "assistant", content: "First answer" },
    { role: "assistant", content: "Second answer", __openclaw: { replyToId: "prompt" } },
  ]);
  expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(1);
  expect(find(".chat-reply-attribution--inline")).toBeNull();
  expect(row.textContent).not.toContain("Original question");
  const target = row.querySelector<HTMLButtonElement>("button")!;
  expect(target.getAttribute("aria-label")).toBe("Replying to Alice");
  expect(target.querySelector(".chat-author-avatar")).not.toBeNull();
  expect(replyName(target)).toBe("Alice");
  target.click();
  expect(onOpenReply).toHaveBeenCalledWith("prompt");
});

const agentAnswer = textMessage("assistant", "Earlier answer", { id: "earlier" });
const jordan = { id: "jordan", name: "Jordan" };
const typedJordan = { ...jordan, identity: { type: "profile", id: "jordan" } } as const;

const namesake = textMessage("user", "Earlier question", {
  id: "earlier",
  senderId: "namesake",
  senderName: "OpenClaw",
  senderIdentity: { type: "profile", id: "namesake" },
});
const jordanQuestion = textMessage("user", "Earlier question", {
  id: "earlier",
  senderId: "jordan",
  senderName: "Jordan",
  senderIdentity: typedJordan.identity,
});
it.each([
  ["an untyped peer replying to the agent", "user", jordan, agentAnswer, "OpenClaw", "Jordan"],
  ["the agent replying to itself", "assistant", undefined, agentAnswer, "OpenClaw", null],
  ["the agent replying to a namesake", "assistant", undefined, namesake, "OpenClaw", "OpenClaw"],
  ["a typed peer replying to itself", "user", typedJordan, jordanQuestion, "Jordan", "Jordan"],
] as const)(
  "keeps the sender name of %s unless the group strip names that same identity",
  (_replier, role, sender, original, strip, senderName) => {
    renderGroup(
      {
        ...groupDefaults,
        key: "reply-group",
        role,
        replyShared: true,
        ...(sender ? { sender, senderLabel: sender.name } : {}),
        messages: entries([textMessage(role, "Reply", { id: "reply", replyToId: "earlier" })]),
      },
      {
        avatarPlacement: "none",
        userId: "alice",
        assistantName: "OpenClaw",
        resolveReplyPreview: loadedPreview("earlier", original, strip),
      },
    );
    expect(replyName(find(".chat-reply-attribution--reply"))).toBe(strip);
    expect(find(".chat-sender-name")?.textContent ?? null).toBe(senderName);
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
] as const)("settles $status lookups ($reserve, $snapshot)", ({ status, snapshot, reserve }) => {
  const { row } = draw(prompt, [reply("deleted", snapshot)], false, "group", {
    ...(reserve ? (status === "oversized" ? turnSource : { replyShared: true }) : {}),
    ...(status ? { [status]: ["deleted"] } : {}),
  });
  if (!reserve) {
    expect(find(".chat-reply-attribution")).toBeNull();
    expect(container.textContent).not.toContain("Original message unavailable");
    return;
  }
  const unavailable = status === "missing" || (status === "oversized" && !snapshot);
  const name = snapshot?.senderLabel;
  expect(row.classList.contains("chat-reply-attribution--pending")).toBe(status === "pending");
  expect(replyName(row)).toBe(name);
  expect(Boolean(row.querySelector(".chat-reply-attribution__person"))).toBe(Boolean(name));
  expect(unavailableElement(row)?.textContent).toBe(
    unavailable ? "Original message unavailable" : undefined,
  );
  expect(Boolean(row.querySelector(".chat-author-avatar, button, a"))).toBe(
    status === "oversized" && !unavailable,
  );
});

it.each([
  ["group", true, 0, "", true],
  ["group", false, 0, "", true],
  ["frame", false, 0, "", true],
  ["group", false, 1, "", false],
  ["frame", false, 1, "", false],
  ["group", false, 1, "Earlier question", false],
  ["frame", false, 0, "Earlier question", false],
] as const)(
  "selects and settles the strongest snapshot in a %s (shared %s, index %s, text %s, settle %s)",
  (presentation, shared, snapshotIndex, text, settle) => {
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
      expect(replyName(row)).toBe("Jordan");
      if (lookup === "missing") {
        expect(unavailableElement(row)?.textContent).toBe("Original message unavailable");
        expect(row.querySelector(".chat-author-avatar, button, a")).toBeNull();
      } else {
        expect(row.querySelector(".chat-author-avatar")).not.toBeNull();
        expect(unavailableElement(row)).toBeNull();
        expect(find(".chat-reply-attribution--inline")).toBeNull();
        row.querySelector<HTMLButtonElement>("button.chat-reply-attribution__target")!.click();
        expect(onOpenReply).toHaveBeenCalledWith("older");
      }
      cleanupSolid();
      container.remove();
    }
  },
);

const reply = (id: string, snapshot?: Snapshot) =>
  textMessage("assistant", "Answer", { replyToId: id, replyToPreview: snapshot });

it.each([
  { promptRun: undefined, name: undefined, anonymous: false },
  { promptRun: undefined, name: undefined, anonymous: true },
  { promptRun: "run-a", name: undefined, anonymous: false },
  { promptRun: "run-b", name: "Alice", anonymous: false },
])("attributes paged-out prompts by run ($promptRun)", ({ promptRun, name, anonymous }) => {
  const paged = textMessage("user", "Deploy?", {
    id: "p1",
    ...(anonymous ? {} : { senderName: "Alice", idempotencyKey: `${promptRun}:user` }),
  });
  const answer = {
    ...reply("p1", anonymous ? undefined : { senderLabel: "Alice", text: "Deploy?" }),
    content: "Deploying",
  };
  const { row } = draw(prompt, [answer], false, "group", {
    runId: "run-a",
    replyToSender: undefined,
    replyToMessage: undefined,
    ...(promptRun || anonymous ? { fetched: { p1: paged } } : { pending: ["p1"] }),
  });
  if (anonymous) {
    expect(find(".chat-reply-attribution")).toBeNull();
  }
  expect(replyName(row)).toBe(name);
  expect(find(".chat-reply-attribution--pending")).toBeNull();
});

it("does not resolve a shared reply_to_current to a prompt without sender provenance", () => {
  const unattributed = textMessage("user", "Question", { id: "current" });
  draw(prompt, [currentReply], true, "group", {
    replyShared: true,
    replyCurrentSource: { key: "current-render-key", message: unattributed },
    sources: { current: { message: unattributed, senderLabel: "Message" } },
  });
  expect(find(".chat-reply-attribution")).toBeNull();
});

it.each([
  { finalTarget: "prompt", recipient: "Alice" },
  { finalTarget: "current-prompt", recipient: "Bob" },
  { finalTarget: "current", recipient: "Bob" },
  { finalTarget: "older", recipient: "Jordan" },
  { finalTarget: undefined, recipient: undefined },
])("attributes frames by final answer ($finalTarget)", ({ finalTarget, recipient }) => {
  const currentPrompt = textMessage("user", "Bob's current question", {
    id: "current-prompt",
    senderId: "bob",
    senderName: "Bob",
  });
  const older = textMessage("user", "Earlier question", {
    id: "older",
    senderId: "jordan",
    senderName: "Jordan",
  });
  const bob = { key: "current-prompt-render-key", message: currentPrompt };
  const explicitOlder = finalTarget === "older" || !finalTarget;
  const responses = [
    explicitOlder ? reply("older") : finalTarget === "current" ? reply("prompt") : currentReply,
    finalTarget === "current"
      ? currentReply
      : finalTarget
        ? reply(finalTarget)
        : { role: "assistant", content: "Final answer" },
  ];
  const context: Parameters<typeof draw>[4] = explicitOlder
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
      };
  draw(prompt, responses, true, "frame", context);
  expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(
    recipient ? 1 : 0,
  );
  expect(replyName(container)).toBe(recipient);
  expect(find(".chat-reply-attribution--inline")).toBeNull();
});

it.each([
  {
    source: { ...prompt, senderLabel: "Alice", __openclaw: { id: "prompt", senderId: "user-123" } },
    explicit: true,
  },
  { source: { role: "user", content: "Pending question" }, explicit: false },
  { source: null, explicit: false },
])("only navigates to persisted recipients ($source)", ({ source, explicit }) => {
  const { row } = draw(source, explicit ? [reply("prompt")] : undefined);
  expect(replyName(row)).toBe("Alice");
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
    expect(unavailableElement(row)).toBeNull();
    expect(row.nextElementSibling?.classList.contains("chat-bubble")).toBe(true);
  }
});

it.each([
  ["assistant", { type: "agent", id: "main" }, "OpenClaw", "OpenClaw"],
  ["user", { type: "profile", id: "alice" }, "Alice", "You"],
  ["user", { type: "profile", id: "jordan" }, "Jordan", "Jordan"],
] as const)(
  "renders an inline reply through the source identity owner (%s, %j, %s, %s)",
  (role, identity, name, label) => {
    const source = textMessage(role, "The original answer", {
      id: "inline-source",
      senderIdentity: identity,
      senderId: identity.id,
      senderName: name,
    });
    const onOpenReply = vi.fn();
    renderGroup(ownReplyGroup("inline-user", "inline-source"), {
      userId: "alice",
      resolveReplyPreview: loadedPreview("inline-source", source, name, "Alice"),
      onOpenReply,
    });
    const row = find<HTMLButtonElement>(
      ".chat-bubble > .chat-reply-attribution--inline .chat-reply-attribution__target",
    )!;
    expect(row.getAttribute("aria-label")).toBe(`Replying to ${label}`);
    expect(replyName(row)).toBe(label);
    expect(row.querySelector(".chat-author-avatar")).not.toBeNull();
    expect(Boolean(row.querySelector(".identity-avatar--agent"))).toBe(role === "assistant");
    expect(find(".chat-reply-connector")).toBeNull();
    const labelElement = find(".chat-reply-attribution__label")!;
    expect(row.contains(labelElement)).toBe(false);
    labelElement.click();
    expect(onOpenReply).not.toHaveBeenCalled();
    row.click();
    expect(onOpenReply).toHaveBeenCalledWith("inline-source");
  },
);

const jordanId = { senderId: "jordan@example.com" };
it.each([
  [false, undefined, undefined, undefined, "Message"],
  [true, undefined, undefined, undefined, undefined],
  [true, undefined, undefined, jordanSnapshot, "Jordan"],
  [true, jordanId, undefined, jordanSnapshot, "Jordan"],
  [true, { ...jordanId, senderName: "Jordan Lee" }, undefined, jordanSnapshot, "Jordan Lee"],
  [true, jordanId, "Jordan Lee", jordanSnapshot, "Jordan Lee"],
  [true, jordanId, undefined, undefined, "jordan"],
] as const)(
  "names a fetched own-reply source from provenance before its snapshot (shared %s, sender %j, label %s, snapshot %j, name %s)",
  (shared, sender, label, snapshot, name) => {
    const original = {
      ...textMessage("user", "Earlier question", { id: "older", ...sender }),
      ...(label ? { senderLabel: label } : {}),
    };
    const resolveReplyPreview = createReplyPreviewResolver(new Map(), {
      assistantName: "OpenClaw",
      userId: "alice",
      replyMessageAccess: { read: (id) => (id === "older" ? original : undefined) },
    });
    renderGroup(
      {
        ...ownReplyGroup("own-reply", "older", snapshot),
        ...(shared ? { replyShared: true } : {}),
      },
      { userId: "alice", resolveReplyPreview },
    );
    expect(replyName(find(".chat-bubble > .chat-reply-attribution--inline"))).toBe(name);
    expect(find(".chat-reply-attribution--pending")).toBeNull();
  },
);
