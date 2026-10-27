/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
import { createChatMessageHarness, buildItems } from "./chat-message-render.test-support.tsx";
import {
  createAssistantMessage,
  createUserMessage,
  prepareMessageGroup,
  createMediaBlock,
  createMessageGroup,
  createMessageEntry,
} from "./chat-message.test-support.ts";

const harness = createChatMessageHarness();
const {
  render,
  renderStreamGroup,
  renderChatNotice,
  requireElement,
  element,
  elements,
  elementText,
  expectCount,
  expectAbsent,
  expectPresent,
  renderTestMessageGroup,
  renderAssistantMessage,
  renderAssistantMessages,
  renderGroupedMessage,
  renderMarkdownHtml,
  markdownRenderMock,
} = harness;

it.each([
  [
    "bounded structured status",
    ["one", "two", "three", "four", "five", "six"].map((name) => `src/${name}.ts`),
    "claim-456",
    7,
  ],
  ["escaped terminal-control filenames", ["src/line\nbreak.ts"], "claim-control", undefined],
] as const)("renders %s in durable history", (_label, paths, ref, totalCount) => {
  const stagedResultRef = `refs/openclaw/worker-results/${ref}`;
  renderGroupedMessage(
    {
      role: "custom",
      customType: "cloud-workspace-conflict",
      content: "fallback summary that should not render as plain text",
      details: { paths, stagedResultRef, ...(totalCount === undefined ? {} : { totalCount }) },
      timestamp: 1,
    },
    "custom",
  );
  expect(harness.view.textContent).toContain(stagedResultRef);
  if (totalCount === undefined) {
    expect(elementText(".chat-workspace-conflict-paths code")).toBe("src/line\\u{000a}break.ts");
  } else {
    expectPresent(".chat-group.workspace-conflict");
    const card = requireElement(".chat-workspace-conflict-event", HTMLDivElement);
    expect(card.textContent).toContain("Cloud result applied with 7 conflicts");
    expect(card.querySelectorAll(".chat-workspace-conflict-paths li")).toHaveLength(5);
    expect(card.textContent).toContain("+2 more paths");
    expect(card.textContent).toContain(stagedResultRef);
    expect(card.querySelector(".chat-text")).toBeNull();
    expect(elementText(".chat-sender-name")).toBe("Cloud workspace");
  }
});

describe("grouped chat rendering", () => {
  function applyNotice(
    host: ReturnType<typeof createHost>,
    seq: number,
    data: Parameters<typeof agentEvent>[3],
    runId = "run-guardian",
    stream: Parameters<typeof agentEvent>[2] = "codex_app_server.guardian",
  ) {
    handleAgentEvent(host, agentEvent(runId, seq, stream, data));
  }

  function renderNotices(host: ReturnType<typeof createHost>, runId: string, paneId: string) {
    const items = buildItems({
      paneId,
      runId,
      guardianNotices: host.guardianNotices,
    });
    if (!items.length || !items.every((item) => item.kind === "notice")) {
      throw new Error("Expected notice projections");
    }
    render(items.map((item) => renderChatNotice(item)));
  }

  it.each([
    { customType: "run-failed-before-reply", label: "Error" },
    { customType: "system-notice", label: "System" },
  ])("labels $customType notices as $label", ({ customType, label }) => {
    renderGroupedMessage(
      {
        role: "custom",
        customType,
        content: "Notice details",
        display: true,
        timestamp: Date.now(),
      },
      "custom",
    );
    expect(elementText(".chat-sender-name")).toBe(label);
    expect(harness.view.textContent).toContain("Notice details");
  });

  it.each([
    {
      state: "failed",
      label: "Not sent",
      actionLabel: "Check failure",
      retry: true,
      discard: false,
    },
    { state: "held", label: "Needs review", actionLabel: undefined, retry: true, discard: true },
    {
      state: "waiting-reconnect",
      label: "Waiting for reconnect",
      actionLabel: undefined,
      retry: false,
      discard: true,
    },
    { state: "submitting", label: "Queued", actionLabel: undefined, retry: false, discard: true },
    { state: "sending", label: "Queued", actionLabel: undefined, retry: false, discard: true },
    {
      state: "waiting-model",
      label: "Queued",
      actionLabel: undefined,
      retry: false,
      discard: true,
    },
    { state: "waiting-idle", label: "Queued", actionLabel: undefined, retry: false, discard: true },
  ] as const)(
    "shows a $state footer with its diagnostic and recovery actions ($actionLabel)",
    ({ state, label, actionLabel, retry: canRetry, discard: canDiscard }) => {
      const onRetryQueuedMessage = vi.fn();
      const onDiscardQueuedMessage = vi.fn();
      renderGroupedMessage(
        createUserMessage("Attempted message", {
          timestamp: 1_000,
          __openclaw: {
            id: "attempted-send",
            kind: "pending-send",
            state,
            error: "Delivery diagnostic",
          },
        }),
        "user",
        {
          onRetryQueuedMessage,
          onDiscardQueuedMessage,
          queuedMessageAction: actionLabel
            ? { id: "attempted-send", label: actionLabel }
            : undefined,
        },
      );

      const status = element(".chat-send-status");
      expect(status).not.toBeNull();
      expect(status?.title).toBe("Delivery diagnostic");
      expect(status?.textContent).toContain(label);
      expect(status?.textContent).not.toContain("unconfirmed");
      expectAbsent(".chat-group-timestamp");
      const retry = status?.querySelector<HTMLButtonElement>(".chat-send-status__retry");
      expect(Boolean(retry)).toBe(canRetry);
      retry?.click();
      expect(onRetryQueuedMessage.mock.calls).toEqual(canRetry ? [["attempted-send"]] : []);
      const discard = status?.querySelector<HTMLButtonElement>(".chat-send-status__discard");
      if (canDiscard) {
        discard?.click();
        expect(onDiscardQueuedMessage).toHaveBeenCalledWith("attempted-send");
        discard?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
        expect(onDiscardQueuedMessage).toHaveBeenCalledTimes(1);
        expect(onRetryQueuedMessage).toHaveBeenCalledTimes(canRetry ? 1 : 0);
      } else {
        expect(discard).toBeNull();
      }
      const bubble = element(".chat-bubble");
      renderGroupedMessage(createUserMessage("Attempted message", { timestamp: 1_000 }), "user");
      expectAbsent(".chat-send-status");
      expect(element(".chat-bubble")).toBe(bubble);
      expect(requireElement(".chat-group-timestamp", HTMLTimeElement).dateTime).toBe(
        new Date(1_000).toISOString(),
      );
    },
  );

  it("collapses long image-bearing user messages and toggles their disclosure state", async () => {
    const collapsedLines = ["Inspect AGENTS.md:188 first.", "a".repeat(1_201)];
    const expandedTail = "Full prompt tail after the disclosure boundary.";
    const markdownContent = [...collapsedLines, expandedTail].join("\n");
    const message = createUserMessage(
      [
        { type: "text", text: markdownContent },
        createMediaBlock({
          url: "data:image/png;base64,cG5n",
          alt: "Sent image",
          width: 640,
          height: 640,
        }),
      ],
      { timestamp: 1001 },
    );
    const onToggleUserMessageExpanded = vi.fn();
    markdownRenderMock
      .mockImplementationOnce(renderMarkdownHtml)
      .mockImplementationOnce(renderMarkdownHtml);

    for (const expanded of [false, true]) {
      renderGroupedMessage(message, "user", {
        isUserMessageExpanded: () => expanded,
        onToggleUserMessageExpanded,
      });
      await vi.dynamicImportSettled();
      const disclosure = requireElement(".chat-message-disclosure", HTMLDivElement);
      const toggle = requireElement(
        ".chat-message-disclosure__toggle",
        HTMLButtonElement,
        disclosure,
      );
      const text = requireElement(".chat-text", HTMLDivElement, disclosure);
      const fileLink = requireElement("a.markdown-file-link", HTMLAnchorElement, text);
      expect(
        requireElement(".chat-bubble", HTMLDivElement).classList.contains(
          "chat-bubble--with-images",
        ),
      ).toBe(true);
      expectPresent(".chat-message-image");
      expect(disclosure.classList.contains("is-expanded")).toBe(expanded);
      expect(text.textContent).toContain(expandedTail);
      expect(fileLink.dataset).toMatchObject({ filePath: "AGENTS.md", fileLine: "188" });
      expect(toggle.textContent?.trim()).toBe(expanded ? "Show less" : "Show more");
      expect(toggle.getAttribute("aria-expanded")).toBe(String(expanded));
      if (!expanded) {
        toggle.click();
        expect(onToggleUserMessageExpanded).toHaveBeenCalledWith("user-message:user-message");
      }
    }
  });

  it("uses the largest prompt for context and aggregates usage, cache, and nested cost", () => {
    renderAssistantMessages(
      [
        createAssistantMessage("Checking", {
          usage: { input: 100_000, output: 900_000, cost: { total: 0.1234 } },
          timestamp: 1000,
        }),
        createAssistantMessage("Done", {
          usage: { input: 1, output: 1200, cacheRead: 438_400, cacheWrite: 307 },
          model: "example/provider-model",
          timestamp: 1001,
        }),
      ],
      { contextWindow: 1_000_000 },
    );
    expect(elementText(".msg-meta__ctx")).toBe("44% ctx");
    expect(elements(".msg-meta__tokens").map((node) => node.textContent)).toEqual([
      "↑100k",
      "↓901.2k",
    ]);
    expect(elements(".msg-meta__cache").map((node) => node.textContent)).toEqual([
      "R438.4k",
      "W307",
    ]);
    expect(elementText(".msg-meta__cost")).toContain("$0.12");
  });

  it("renders relative and compact dates while clamping clock skew", () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 5, 24, 18, 30);
    vi.setSystemTime(now);
    const renderTimestamp = (timestamp: number) => {
      renderAssistantMessage(createAssistantMessage("Done", { timestamp }));
      return elementText(".chat-group-timestamp")?.trim();
    };

    const recent = now - 5 * 60_000;
    expect(renderTimestamp(recent)).toBe("5m ago");
    expect(harness.view.querySelector<HTMLTimeElement>(".chat-group-timestamp")?.dateTime).toBe(
      new Date(recent).toISOString(),
    );
    const oldTimestamp = Date.UTC(2026, 3, 24, 18, 30);
    expect(renderTimestamp(oldTimestamp)).toBe(
      new Date(oldTimestamp).toLocaleDateString([], { month: "short", day: "numeric" }),
    );
    expect(renderTimestamp(now + 30_000)).toBe("Just now");
    expect(renderTimestamp(now - 10_000)).toBe("Just now");

    const nextYear = Date.UTC(2027, 3, 24, 18, 30);
    expect(renderTimestamp(nextYear)).toBe(
      new Date(nextYear).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    );
  });

  it("keeps streaming participant attribution on the shared reply renderer", () => {
    const container = document.createElement("div");
    renderStreamGroup(
      [
        {
          kind: "stream",
          key: "stream:participant",
          text: "Reviewing the checklist.",
          startedAt: 1,
          isStreaming: true,
          replyToSender: { name: "Alice Chen", identity: { type: "profile", id: "alice" } },
          replyToMessage: {
            key: "prompt",
            message: {
              role: "user",
              content: "Review the release checklist.",
              __openclaw: { id: "prompt" },
            },
          },
        },
      ],
      {},
      container,
    );
    expect(container.querySelectorAll(".chat-reply-attribution--reply")).toHaveLength(1);
    expect(elementText(".chat-reply-attribution__name", container)).toBe("Alice Chen");
    expect(container.querySelectorAll(".chat-reply-connector")).toHaveLength(1);
    expect(container.querySelector(".chat-group--reply")).not.toBeNull();
  });

  it("morphs one assistant turn from working status to its terminal recap", () => {
    const message = createAssistantMessage("First result is ready.", { timestamp: 1_000 });

    renderAssistantMessage(message, {
      activeContinuation: {
        parts: [{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }],
        options: {},
      },
    });

    expectCount(".chat-group.assistant", 1);
    expectAbsent(".chat-reading-indicator");
    expectPresent(".chat-working-indicator--continuation");
    expect(elementText(".chat-working-indicator__status")).toContain("Working…");
    // The footer row is reserved but empty until the turn settles.
    expect(element(".chat-group-footer")?.childElementCount).toBe(0);

    renderAssistantMessage(message, {
      turnRecap: { runtimeMs: 4 * 3_600_000 + 2 * 60_000, outputTokens: 1 },
    });

    expectCount(".chat-group.assistant", 1);
    expectAbsent(".chat-working-indicator");
    // Usage leads and the duration follows, matching the live indicator's order.
    expect(
      Array.from(element(".chat-turn-recap--continuation")!.children, (child) =>
        child.textContent?.trim(),
      ),
    ).toEqual(["1 output token", "·", "Done in 4 hours, 2 minutes"]);
    expectAbsent(".chat-turn-recap__claw");
    expectPresent(".chat-group-footer");
  });

  it("shows live output tokens before the elapsed time", () => {
    renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
      runOutputTokens: 892,
    });

    const status = element(".chat-working-indicator__status");
    const tokens = status?.querySelector(".chat-working-indicator__tokens");
    const elapsed = status?.querySelector(".chat-working-indicator__elapsed");
    expect(tokens?.textContent).toBe("892 output tokens");
    expect(elapsed).not.toBeNull();
    expect(
      tokens!.compareDocumentPosition(elapsed!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(status?.querySelector("openclaw-working-phrase")).toBeNull();
  });

  it("relabels the working indicator while the run waits for approval", () => {
    renderStreamGroup([{ kind: "reading-indicator", key: "reading", startedAt: 1_000 }], {
      startupLabel: "Waiting for a response",
      waitingApproval: true,
      runOutputTokens: 5_500,
    });

    expect(elementText(".chat-working-indicator__status")).toContain("Waiting for approval…");
    expectAbsent(".chat-working-indicator__elapsed");
    expect(elementText(".chat-working-indicator__tokens")).toBe("5.5k output tokens");
  });

  it("keeps streamed assistant content in the guttered group without an avatar", () => {
    renderStreamGroup(
      [
        {
          kind: "stream",
          key: "stream:s:live",
          text: "reply",
          startedAt: 10,
          isStreaming: true,
        },
        { kind: "reading-indicator", key: "reading", startedAt: 10 },
      ],
      { showAssistantAvatar: false },
    );

    const group = element(".chat-group.assistant");
    expect(group?.classList.contains("chat-group--working")).toBe(false);
    expect(group?.classList.contains("chat-group--with-footer")).toBe(true);
    expectCount(".chat-avatar.assistant", 0);
    expect(element(".chat-group-footer")?.childElementCount).toBe(0);
    expectCount(".chat-working-indicator", 1);
    expectCount(".chat-reading-indicator", 1);
    renderStreamGroup(
      [
        {
          kind: "stream",
          key: "stream:s:live",
          text: "reply",
          startedAt: 10,
          isStreaming: false,
        },
      ],
      { showAssistantAvatar: false },
    );
    expectAbsent(".chat-bubble.streaming");
    expect(harness.view.querySelector<HTMLTimeElement>(".chat-group-timestamp")?.dateTime).toBe(
      new Date(10).toISOString(),
    );
  });

  it.each([
    [
      "qualified local profile",
      {
        senderId: "profile-buns",
        senderIdentity: { type: "profile", id: "profile-buns" },
      },
      { userId: "profile-buns", userName: "Buns" },
      "Buns",
      undefined,
      "DIV",
    ],
    [
      "authenticated human with CLI provenance",
      {
        senderId: "profile-1",
        senderName: "Recorded Name",
        senderIdentity: { type: "profile", id: "profile-1" },
        transport: { clients: [{ id: "cli", mode: "cli", displayName: "Task helper" }] },
      },
      { userId: "profile-1", userName: "Current Name" },
      "Current Name",
      "via CLI (Task helper)",
      undefined,
    ],
    [
      "source-only Web and external clients",
      {
        transport: {
          clients: [
            { id: "openclaw-control-ui", mode: "webchat" },
            { id: "cli", mode: "cli", displayName: "Release helper" },
            { id: "gateway-client", mode: "backend", displayName: "Build helper" },
          ],
        },
      },
      {
        avatarPlacement: "gutter",
        userName: "Unrelated Viewer",
        userAvatar: "https://example.test/viewer.png",
      },
      undefined,
      "via CLI (Release helper), RPC (Build helper)",
      null,
    ],
  ] as const)(
    "keeps sender attribution distinct for %s",
    (_label, metadata, options, sender, source, avatar) => {
      const message = createUserMessage("Follow up on the current task.", {
        timestamp: 1000,
        __openclaw: metadata,
      });
      const group = prepareMessageGroup(createMessageEntry("source-message", message));
      render(renderTestMessageGroup(group, options));
      if (sender === undefined) {
        expectAbsent(".chat-sender-name");
        expect(harness.view.textContent).not.toContain("Unrelated Viewer");
      } else {
        expect(elementText(".chat-group.user .chat-sender-name")).toBe(sender);
      }
      if (avatar === null) {
        expectAbsent(".chat-avatar, .chat-author-avatar");
      } else if (avatar !== undefined) {
        expect(element(".chat-avatar.user")?.tagName).toBe(avatar);
      }
      expect(elementText(".chat-message-source")).toBe(source);
    },
  );

  it("sender provenance links only profiles and does not identify colliding legacy senders as you", () => {
    const navigate = vi.fn();
    const renderSender = (senderId: string, profile = true) => {
      const message = createUserMessage("hello", { timestamp: 1000 });
      render(
        renderTestMessageGroup(
          createMessageGroup(message, "user", {
            key: `sender-link-${senderId}`,
            senderLabel: "Alice Example",
            sender: {
              id: senderId,
              name: "Alice Example",
              ...(profile ? { identity: { type: "profile" as const, id: senderId } } : {}),
            },
          }),
          {
            userId: "me",
            userName: "Local User",
            personActivity: { basePath: "", navigate },
          },
        ),
      );
      return harness.view;
    };

    const peer = renderSender("profile-alice");
    const link = peer.querySelector<HTMLAnchorElement>("a.chat-sender-name");
    expect(link?.textContent).toBe("Alice Example");
    expect(link?.getAttribute("href")).toBe("/activity/profile-alice");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("profile-alice", "Alice Example");

    const own = renderSender("me");
    expect(own.querySelector("a.chat-sender-name")).toBeNull();
    expect(own.querySelector(".chat-sender-name")?.textContent).toBe("Local User");
    const legacy = renderSender("me", false);
    expect(legacy.querySelector("a.chat-sender-name")).toBeNull();
    expect(legacy.querySelector(".chat-sender-name")?.textContent).toBe("Alice Example");
    expect(renderSender("profile-alice", false).querySelector("a.chat-sender-name")).toBeNull();
  });

  it("renders multiline system notices as sanitized markdown", async () => {
    markdownRenderMock.mockImplementationOnce(renderMarkdownHtml);
    render(
      renderChatNotice({
        kind: "notice",
        key: "notice:command",
        icon: "cpu",
        label: "System",
        text: "**first line**\nsecond line\n<img src=x onerror=alert(1)><script>alert(1)</script>",
        timestamp: 1000,
      }),
    );

    await waitForSolid(() => expect(element(".chat-notice")).not.toBeNull());
    const notice = element(".chat-notice");
    expect(notice?.querySelector(".chat-divider__title")?.textContent).toBe("System");
    expect(notice?.querySelector("strong")?.textContent).toBe("first line");
    expect(notice?.querySelector("br")).not.toBeNull();
    expect(notice?.textContent).toContain("second line");
    expect(notice?.querySelector("script")).toBeNull();
    expect(notice?.querySelector("img[onerror]")).toBeNull();
  });

  it("renders Codex guardian decisions and warnings in the transcript", async () => {
    const host = createHost();
    applyNotice(host, 1, {
      phase: "completed",
      reviewId: "review-approved",
      status: "approved",
      command: "git status --short",
    });
    applyNotice(host, 2, {
      phase: "completed",
      reviewId: "review-denied",
      status: "denied",
      command: "curl https://example.invalid",
      riskLevel: "high",
      rationale: "Command reaches the network.",
    });
    applyNotice(host, 3, {
      phase: "warning",
      message: "Guardian stopped after too many rejected actions.",
    });
    applyNotice(host, 4, {
      phase: "strict_review_required",
    });
    renderNotices(host, "run-guardian", "guardian-render-test");
    await waitForSolid(() => expect(elements(".chat-notice")).toHaveLength(4));

    const notices = elements(".chat-notice");
    expect(notices).toHaveLength(4);
    expect(notices[0]?.textContent).toContain("Guardian approved git status --short.");
    expect(notices[0]?.classList.contains("danger")).toBe(false);
    expect(notices[1]?.classList.contains("callout")).toBe(true);
    expect(notices[1]?.classList.contains("danger")).toBe(true);
    expect(notices[1]?.getAttribute("role")).toBe("alert");
    expect(notices[1]?.textContent).toContain("Guardian denied");
    expect(notices[1]?.textContent).toContain("curl https://example.invalid · risk: high");
    expect(notices[1]?.textContent).toContain("Command reaches the network.");
    expect(notices[2]?.textContent).toContain("Guardian warning");
    expect(notices[2]?.textContent).toContain("Guardian stopped after too many rejected actions.");
    expect(notices[3]?.classList.contains("callout")).toBe(true);
    expect(notices[3]?.classList.contains("danger")).toBe(true);
    expect(notices[3]?.getAttribute("role")).toBe("alert");
    expect(notices[3]?.textContent).toContain("Guardian review required");
    expect(notices[3]?.textContent).toContain(
      "Guardian is reviewing this action before it can continue.",
    );
  });

  it("correlates strict review replay and terminal decisions by thread and turn", () => {
    const host = createHost();
    const correlation = { threadId: "thread-guardian", reviewId: "review-shared" };
    const strictReview = (seq: number, turnId: string) =>
      applyNotice(host, seq, {
        ...correlation,
        phase: "strict_review_required",
        turnId,
        startedAtMs: 1_787_273_600_000,
      });

    strictReview(1, "turn-1");
    strictReview(2, "turn-1");
    strictReview(3, "turn-2");
    expect(host.guardianNotices).toHaveLength(2);

    applyNotice(host, 4, {
      ...correlation,
      phase: "completed",
      turnId: "turn-1",
      status: "approved",
    });
    expect(host.guardianNotices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "approved" }),
        expect.objectContaining({ kind: "strict-review-required" }),
      ]),
    );

    applyNotice(host, 5, {
      ...correlation,
      phase: "completed",
      turnId: "turn-2",
      status: "aborted",
    });
    expect(host.guardianNotices).toEqual([
      expect.objectContaining({ kind: "approved" }),
      expect.objectContaining({ kind: "denied" }),
    ]);
  });

  it("renders configuration warnings as system notices rather than Guardian failures", async () => {
    const host = createHost();
    applyNotice(
      host,
      1,
      {
        phase: "warning",
        message: "Custom execution rules were not applied.",
      },
      "run-warning",
      "notice",
    );
    renderNotices(host, "run-warning", "configuration-warning-render-test");
    await waitForSolid(() => expect(elementText(".chat-divider__title")).toBe("System"));

    expect(elementText(".chat-divider__title")).toBe("System");
    expect(harness.view.textContent).toContain("Custom execution rules were not applied.");
    expect(harness.view.textContent).not.toContain("Guardian warning");
  });

  it("falls back to initials when a user avatar image fails", async () => {
    const message = createUserMessage("hello", { timestamp: 1000 });
    const group = createMessageGroup(message, "user", {
      key: "gravatar-user",
      senderLabel: "alice",
      // A gateway avatar exercises the image tier without third-party requests.
      sender: { id: "alice@example.com", profileAvatarUrl: "/api/users/alice/avatar" },
    });
    render(renderTestMessageGroup(group, { avatarPlacement: "footer" }));

    const image = await vi.waitFor(() => {
      const result = harness.view.querySelector<HTMLImageElement>(".chat-author-avatar__image");
      expect(result).not.toBeNull();
      expect(result?.getAttribute("src")).toBe("/api/users/alice/avatar");
      return result!;
    });
    image.dispatchEvent(new Event("error"));
    await waitForSolid(() => expect(image.parentElement?.classList).toContain("is-fallback"));
    expect(elementText(".chat-author-avatar__fallback")?.trim()).toBe("A");
  });

  it("keeps a persisted reply preview busy until its target resolves, then opens it", () => {
    document.body.append(harness.view);
    const onOpenReply = vi.fn();
    const preview = { senderLabel: "Marie", text: "The original answer" };
    const message = createUserMessage("Follow up", {
      __openclaw: { replyToId: "transcript-123", replyToPreview: preview },
    });
    const show = (loading: boolean) =>
      renderGroupedMessage(message, "user", {
        onOpenReply,
        replyNavigationId: loading ? "transcript-123" : null,
        resolveReplyPreview: () =>
          loading
            ? undefined
            : {
                ...preview,
                messageId: "source-message",
                sourceMessageId: "transcript-123",
              },
      });
    show(true);
    const button = requireElement(".chat-reply-attribution__target", HTMLButtonElement);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    button.click();
    expect(onOpenReply).not.toHaveBeenCalled();
    show(false);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Replying to Marie");
    expect(button.textContent).not.toContain("The original answer");
    button.click();
    expect(onOpenReply).toHaveBeenCalledWith("transcript-123");
    expect(elementText(".chat-text")?.trim()).toBe("Follow up");
  });
});
