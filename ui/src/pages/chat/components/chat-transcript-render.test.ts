import { expectDefined } from "@openclaw/normalization-core";
/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../../api/types.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../../../app/theme-branding.ts";
import { resolveAvatarHat } from "../../../components/agent-avatar-hat.ts";
import { latestBrowserTabCards } from "../../../lib/chat/browser-tab-preview.ts";
import { sessionListResult } from "../../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import {
  interruptedChatHistory,
  interruptedChatCommentary,
} from "../../../test-helpers/interrupted-chat-history.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import * as artworkLoader from "../../plugins/icon-loader.ts";
import { createInitializationContext } from "../chat-application-context.test-support.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "../history-merge.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { projectChatTranscriptMetadata } from "../session-message-cache.ts";
import { render, renderTranscriptSearch } from "../test-helpers/chat-transcript-native.tsx";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
import { createChatThreadHarness } from "./chat-message-native.test-support.tsx";
import {
  getTranscriptState,
  toggleTranscriptSearch,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import { transcriptContainer } from "./chat-transcript-fixture.test-support.tsx";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  requireElement,
  resetTranscriptTestDom,
  threadProps,
  transcriptMessage as message,
} from "./chat-transcript.test-support.ts";

const cleanups = new Set<() => void>();
function threadFixture(
  props: ChatThreadProps,
  transcript = createTestTranscript(),
  search = false,
) {
  const container = transcriptContainer();
  const searchContainer = search ? transcriptContainer() : container;
  const thread = createChatThreadHarness(container, transcript);
  const dispose = () => {
    transcript.dispose();
    thread.unmount();
    if (search) {
      render(null, searchContainer);
      searchContainer.remove();
    }
    container.remove();
    cleanups.delete(dispose);
  };
  cleanups.add(dispose);
  const renderOnly = () => thread.render(props);
  const rerender = (start = false) => {
    if (search) {
      render(renderTranscriptSearch(props.paneId), searchContainer);
    }
    renderOnly();
    if (start) {
      transcript.start();
    }
    transcript.update();
  };
  return { container, searchContainer, transcript, renderOnly, rerender, dispose };
}

async function mountThread(props: ChatThreadProps, transcript = createTestTranscript()) {
  const fixture = threadFixture(props, transcript);
  fixture.rerender(true);
  await flushDeferredRowPrune();
  return fixture;
}

async function linkFixture(content: string, changes: Partial<ChatThreadProps> = {}) {
  const onOpenWorkspaceFile = vi.fn();
  const onOpenSessionLink = vi.fn();
  const onHistoryIntent = vi.fn();
  const props = threadProps(
    "pane-link",
    "agent:main:main",
    [message("assistant", content, 1_000)],
    {
      onOpenWorkspaceFile,
      onOpenSessionLink,
      onHistoryIntent,
      ...changes,
    },
  );
  return { ...(await mountThread(props)), onOpenWorkspaceFile, onOpenSessionLink, onHistoryIntent };
}

function activateLink(link: Element | null, action: string) {
  const event =
    action === "click"
      ? new MouseEvent("click", { bubbles: true, button: 0, cancelable: true })
      : new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true });
  link?.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

describe("chat transcript rendering", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(() => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    vi.useRealTimers();
    resetTranscriptTestDom();
  });

  it("keeps cached message context metadata until the live session replaces it", async () => {
    const sessionKey = "agent:main:cached-meta";
    const props = threadProps(
      "cached-meta",
      sessionKey,
      [
        {
          role: "assistant",
          content: "Cached reply with usage",
          usage: { input: 20_000, output: 100 },
          timestamp: 1_000,
        },
      ],
      { transcriptMetadata: { key: sessionKey, kind: "direct", contextTokens: 100_000 } },
    );
    const { container, rerender } = await mountThread(props);
    expect(container.querySelector(".msg-meta__ctx")?.textContent).toBe("20% ctx");
    props.transcriptMetadata = undefined;
    props.selectedSession = { key: sessionKey, kind: "direct", contextTokens: 200_000 };
    rerender();
    await waitForSolid(() =>
      expect(container.querySelector(".msg-meta__ctx")?.textContent).toBe("10% ctx"),
    );
  });

  it.each([true, false])(
    "renders an inactive run without a terminal row (show tools=%s)",
    async (showTools) => {
      const props = threadProps(
        "interrupted-history",
        "agent:main:dashboard:synthetic",
        attachHistoryActivity(interruptedChatHistory()).messages,
      );
      props.showToolCalls = showTools;
      const { container } = await mountThread(props);
      for (const text of interruptedChatCommentary) {
        expect(container.textContent).toContain(text);
      }
      await waitForSolid(() =>
        expect(Boolean(container.querySelector(".chat-activity-group__summary"))).toBe(showTools),
      );
      expect(container.textContent).toContain("Interrupted");
      expect(container.querySelector(".chat-working-indicator")).toBeNull();
    },
  );

  it.each([
    ["blob:configured-agent", "gutter", "props"],
    ["🦉", "gutter", "fallback-agent"],
    ["blob:configured-agent", "none", null],
  ] as const)(
    "keeps avatar %s and %s placement consistent across saved and streaming replies (emoji from %s)",
    async (avatar, avatarPlacement, emojiSource) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const props = threadProps("pane-agent-avatar");
      props.userId = "synthetic-owner";
      props.assistantAvatar = emojiSource === "props" ? "🦉" : avatar;
      props.assistantAvatarUrl = avatar.startsWith("blob:") ? avatar : null;
      if (emojiSource === "fallback-agent") {
        props.currentAgentId = undefined;
        props.fullMessageAgentId = "writer";
        props.assistantAvatar = null;
        props.agents = [
          { id: "main", identity: { avatarUrl: "/avatar/main", emoji: "🦞" } },
          { id: "writer", identity: { emoji: "🦉" } },
        ];
      }
      if (avatarPlacement === "none") {
        props.sessionKey = "agent:main:subagent:avatar-test";
      }
      props.stream = "Reply in progress";
      props.streamStartedAt = 5_000;
      props.runActive = true;
      saveChatSessionScrollPosition(props.paneId, props.sessionKey, {
        scrollTop: 0,
        anchorToEnd: false,
      });
      const { container, rerender } = await mountThread(props, createTestTranscript(props.paneId));
      expect(
        container.querySelector(".chat-thread")?.classList.contains("chat-thread--direct"),
      ).toBe(avatarPlacement !== "gutter");
      const replies = container.querySelectorAll(".chat-group.assistant");
      expect(replies).toHaveLength(3);
      for (const reply of replies) {
        const slot = reply.querySelector(".chat-avatar-slot, .chat-avatar.assistant");
        if (avatarPlacement !== "gutter") {
          expect(slot).toBeNull();
        } else if (avatar.startsWith("blob:")) {
          const image = slot?.querySelector("img.chat-avatar.assistant");
          expect(image?.getAttribute("src")).toBe(avatar);
          expect(image?.getAttribute("alt")).toBe(props.assistantName);
          image?.dispatchEvent(new Event("load"));
          flush();
          expect(slot?.classList.contains("is-fallback")).toBe(false);
          image?.dispatchEvent(new Event("error"));
          flush();
          expect(slot?.classList.contains("is-fallback")).toBe(true);
          expect(slot?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦉");
        } else {
          expect(slot?.querySelector("img")).toBeNull();
          expect(slot?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe(avatar);
        }
      }
      if (emojiSource === "props") {
        props.assistantAvatar = "🦊";
        rerender();
        await flushDeferredRowPrune();
        expect(
          [...container.querySelectorAll(".chat-avatar.assistant [data-avatar]")].map((element) =>
            element.getAttribute("data-avatar"),
          ),
        ).toEqual(["🦊", "🦊", "🦊"]);
      }
    },
  );

  it("refreshes settled avatar hats when only plugin artwork or hat selection changes", async () => {
    const previousBranding = currentThemeBranding();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const fetchArtwork = vi
      .spyOn(artworkLoader, "fetchPluginThemeArtworkBlobUrl")
      .mockImplementation(async ({ url }) => `blob:${url}`);
    let branding = resolveThemeBranding({
      mascot: "claw",
      critters: [],
      avatarHat: "beret",
      artwork: { hats: { beret: { url: "/hat?v=1" } } },
    });
    const agentId = expectDefined(
      Array.from({ length: 100 }, (_, index) => `agent-${index}`).find((id) =>
        resolveAvatarHat(id, branding),
      ),
      "agent wearing a hat",
    );
    const props = threadProps("pane-artwork-refresh", `agent:${agentId}:main`, [
      message("assistant", "A settled reply", 1_000),
    ]);
    props.currentAgentId = agentId;
    props.fullMessageAgentId = agentId;
    props.userId = "synthetic-owner";
    props.assistantAvatar = "🦀";
    props.branding = branding;
    const { container, transcript, rerender } = threadFixture(props);
    const draw = async () => {
      setCurrentThemeBranding(props.branding!);
      rerender();
      await vi.dynamicImportSettled();
      flush();
    };
    try {
      await draw();
      transcript.start();
      expect(container.querySelector(".identity-avatar__hat-img")?.getAttribute("src")).toBe(
        "blob:/hat?v=1",
      );
      branding = { ...branding, artwork: { hats: { beret: { url: "/hat?v=2" } } } };
      props.branding = branding;
      await draw();
      expect(container.querySelector(".identity-avatar__hat-img")?.getAttribute("src")).toBe(
        "blob:/hat?v=2",
      );
      props.branding = { ...branding, avatarHat: "crown" };
      await draw();
      expect(container.querySelector(".identity-avatar__hat--crown svg")).not.toBeNull();
      expect(container.querySelector(".identity-avatar__hat-img")).toBeNull();
    } finally {
      setCurrentThemeBranding(previousBranding);
      fetchArtwork.mockRestore();
      now.mockRestore();
    }
  });

  it("keeps one inline compaction row through completion and history refresh", async () => {
    const props = threadProps("pane-compaction", undefined, undefined, {
      runWorking: true,
      compactionStatus: {
        phase: "active",
        runId: "compact-run",
        startedAt: 5_000,
        completedAt: null,
      },
    });
    const { container, rerender } = await mountThread(props);
    await waitForSolid(() => expect(container.querySelector(".chat-compaction")).not.toBeNull());
    const marker = requireElement(container, ".chat-compaction");
    const glyph = requireElement(marker, ".chat-compaction__glyph");
    expect(marker.textContent).toContain("Compacting context");
    expect(container.querySelector(".chat-working-indicator")).toBeNull();
    props.compactionStatus = {
      phase: "complete",
      runId: "compact-run",
      startedAt: 5_000,
      completedAt: 6_000,
    };
    rerender();
    expect(container.querySelector(".chat-compaction")).toBe(marker);
    expect(marker.textContent).toContain("Context compacted");
    const owner = {
      sessionKey: props.sessionKey,
      chatMessages: props.messages,
      compactionStatus: props.compactionStatus,
    };
    getChatSessionProjection(owner, {
      sessionKey: props.sessionKey,
      activeLeafEntryId: "previous",
    });
    const messages = [
      ...props.messages,
      message("custom", "Context compacted", 6_000, {
        customType: "openclaw.context-compaction",
        __openclaw: { id: "compacted-item", runId: "compact-run" },
      }),
    ];
    reduceChatSessionProjection(
      owner,
      { type: "snapshotLoaded", messages },
      {
        scope: { sessionKey: props.sessionKey, activeLeafEntryId: "compacted-item" },
      },
    );
    props.messages = owner.chatMessages;
    props.compactionStatus = owner.compactionStatus;
    rerender();
    expect(container.querySelectorAll(".chat-compaction")).toHaveLength(1);
    expect(container.querySelector(".chat-compaction")).toBe(marker);
    expect(marker.querySelector(".chat-compaction__glyph")).toBe(glyph);
    expect(container.textContent?.match(/Context compacted/g)).toHaveLength(1);
    props.compactionStatus = null;
    rerender();
    expect(container.querySelector(".chat-compaction")).toBe(marker);
    props.messages = [...props.messages, message("assistant", "Next reply", 9_000)];
    rerender();
    expect(container.querySelector(".chat-compaction")).toBe(marker);
  });

  it("keeps repeated compactions in one run distinct during history adoption", async () => {
    const persisted = (itemId: string, timestamp: number) =>
      message("custom", "Context compacted", timestamp, {
        customType: "openclaw.context-compaction",
        __openclaw: { id: itemId, runId: "same-run", itemId },
      });
    const props = threadProps("pane-repeated-compaction", "agent:main:main", [
      persisted("first", 1_000),
    ]);
    props.compactionStatus = {
      phase: "active",
      runId: "same-run",
      itemId: "second",
      startedAt: 2_000,
      completedAt: null,
    };
    const { container, rerender } = await mountThread(props);
    await waitForSolid(() =>
      expect(container.querySelector(".chat-compaction--active")).not.toBeNull(),
    );
    const active = requireElement(container, ".chat-compaction--active");
    expect(container.querySelectorAll(".chat-compaction")).toHaveLength(2);
    props.messages = [...props.messages, persisted("second", 3_000)];
    rerender();
    expect(container.querySelectorAll(".chat-compaction")).toHaveLength(2);
    expect(active.isConnected).toBe(true);
    expect(active.classList.contains("chat-compaction--complete")).toBe(true);
    expect(container.querySelector(".chat-compaction--active")).toBeNull();
  });

  it("keeps exact-run usage visible through final event batching and later corrections", async () => {
    const runId = "watched-run";
    const sessionKey = "global";
    const host = createHost({ sessionKey, chatRunId: runId });
    const props = threadProps("pane-run-usage", sessionKey, [
      message("user", "Check the workspace", 1_000, {
        __openclaw: { idempotencyKey: `${runId}:user` },
      }),
      message("assistant", "Workspace checked", 2_000, { runId }),
    ]);
    props.gatewayClient = createTestGatewayClient(() => null);
    props.currentAgentId = "first";
    props.runId = runId;
    props.runWorking = true;
    props.selectedSession = {
      key: sessionKey,
      kind: "direct",
      updatedAt: 1,
      status: "done",
      lastRunId: "previous-run",
      endedAt: 1,
      runtimeMs: 1,
      outputTokens: 10,
    };
    const fixture = threadFixture(props);
    const { container, transcript } = fixture;
    const rerender = (changes: Partial<ChatThreadProps> = {}) => {
      Object.assign(props, changes);
      props.runUsageById = host.chatRunUsageById;
      fixture.rerender();
    };
    const expectRecap = (text: string) =>
      expect(requireElement(container, ".chat-turn-recap").textContent).toContain(text);
    handleAgentEvent(
      host,
      agentEvent("sibling-run", 1, "usage", { outputTokens: 900 }, sessionKey),
    );
    rerender();
    transcript.start();
    await flushDeferredRowPrune();
    expect(container.querySelector(".chat-working-indicator__tokens")).toBeNull();

    handleAgentEvent(host, agentEvent(runId, 1, "usage", { outputTokens: 6_900 }, sessionKey));
    rerender();
    expect(requireElement(container, ".chat-working-indicator__tokens").textContent).toBe(
      "6.9k output tokens",
    );
    // Final usage and lifecycle can share one browser render; neither may discard the count.
    handleAgentEvent(host, agentEvent(runId, 2, "usage", { outputTokens: 6_950 }, sessionKey));
    handleAgentEvent(host, agentEvent(runId, 3, "lifecycle", { phase: "end" }, sessionKey));
    rerender({
      runId: null,
      runWorking: false,
      selectedSession: {
        ...props.selectedSession,
        lastRunId: runId,
        endedAt: 16_000,
        runtimeMs: 14_000,
      },
    });
    expectRecap("7k output tokens");
    handleAgentEvent(host, agentEvent(runId, 4, "usage", { outputTokens: 7_094 }, sessionKey));
    rerender();
    expectRecap("7.1k output tokens");
    handleAgentEvent(
      host,
      agentEvent("sibling-run", 2, "usage", { outputTokens: 1_000 }, sessionKey),
    );
    rerender();
    expectRecap("7.1k output tokens");
    for (const replaceOwner of [
      () => {
        props.currentAgentId = "second";
      },
      () => {
        props.gatewayClient = createTestGatewayClient(() => null);
      },
    ]) {
      replaceOwner();
      rerender();
      expect(container.querySelector(".chat-turn-recap")).toBeNull();
      rerender({ currentAgentId: "first", runId, runWorking: true });
      rerender({ runId: null, runWorking: false });
      expectRecap("7.1k output tokens");
    }
    props.messages = [
      ...props.messages,
      message("assistant", "Background reply", 20_000, { runId: "sibling-run" }),
    ];
    rerender();
    expect(container.querySelector(".chat-turn-recap")).toBeNull();
  });

  it("keeps browser cards visible with capture limited to the active pane", async () => {
    const messages = [
      message("user", "Open the example", 1_000),
      message("toolResult", "Opened", 2_000, {
        toolCallId: "browser-call",
        toolName: "browser",
        details: {
          browserTab: {
            profile: "managed",
            target: "host",
            targetId: "tab-1",
            url: "https://example.com",
            title: "Example",
          },
        },
      }),
      message("assistant", "Done.", 3_000),
    ];
    const props = threadProps("pane-browser-work", "agent:main:dashboard:browser", messages, {
      latestBrowserTabs: latestBrowserTabCards(messages, []),
      showToolCalls: true,
    });
    const capture = vi.fn(async () => {
      throw new Error("Screenshot unavailable");
    });
    const context = createInitializationContext();
    context.gateway.snapshot.client = createTestGatewayClient(capture);
    context.gateway.snapshot.phase = "connected";
    context.gateway.snapshot.hello = gatewayHelloForMethods(["browser.request"]);
    props.applicationContext = context;
    const { container } = await mountThread(props);
    expect(container.querySelector(".chat-work-group")).not.toBeNull();
    await waitForSolid(() =>
      expect(container.querySelectorAll<HTMLElement>("openclaw-browser-tab-card")).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(capture).toHaveBeenCalledExactlyOnceWith(
        "browser.request",
        expect.objectContaining({
          method: "POST",
          path: "/screenshot",
          body: { targetId: "tab-1", type: "png" },
        }),
      ),
    );
  });

  it("renders canonical archive attribution as a timestamped notice without a speech bubble", async () => {
    const sessionKey = "agent:work:main";
    const archivedSession: GatewaySessionRow = {
      key: "global",
      kind: "global",
      updatedAt: 2_000,
      archived: true,
      archivedAt: 2_000,
      archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
    };
    const sessions: SessionsListResult = sessionListResult(0, [archivedSession], {
      modelProvider: "openai",
      model: "gpt-5",
      contextTokens: null,
    });
    const props = threadProps(
      "pane-archived-notice",
      sessionKey,
      [message("user", "Before archive", 1_000), message("assistant", "After archive", 3_000)],
      {
        selectedSession: archivedSession,
        sessions,
      },
    );
    const { container, rerender } = await mountThread(props);

    const notice = requireElement(container, ".chat-notice");
    expect(notice.textContent).toContain("Archived by Ada");
    expect(notice.dataset.ts).toBe("2000");
    expect(notice.querySelector(".chat-bubble")).toBeNull();
    expect(container.querySelectorAll(".chat-bubble")).toHaveLength(2);
    expect(
      [...container.querySelectorAll(".chat-virtual-row")].map((row) =>
        row.querySelector(".chat-notice") ? "notice" : "message",
      ),
    ).toEqual(["message", "notice", "message"]);

    const variants: [Partial<GatewaySessionRow>, string | null][] = [
      [{ archivedBy: { type: "human", id: "profile-bob" } }, "Archived by profile-bob"],
      [
        { archivedBy: undefined, archiveReason: "active-session-cap" },
        "Automatically archived because the active-session limit was reached",
      ],
      [{ archivedBy: undefined }, null],
      [{ archived: false, archivedAt: undefined, archivedBy: undefined }, null],
    ];
    for (const [changes, text] of variants) {
      sessions.sessions[0] = { ...archivedSession, ...changes };
      props.selectedSession = sessions.sessions[0];
      rerender();
      if (text === null) {
        expect(container.querySelector(".chat-notice")).toBeNull();
      } else {
        expect(requireElement(container, ".chat-notice").textContent).toContain(text);
      }
    }
  });

  it("commits a cached archive notice with its rows and replaces only differing live facts", () => {
    const sessionKey = "agent:main:cached-archive";
    const archived: GatewaySessionRow = {
      key: sessionKey,
      sessionId: "cached-archive-session",
      kind: "direct",
      archived: true,
      archivedAt: 2_000,
      archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
    };
    const props = threadProps(
      "cached-archive",
      sessionKey,
      [message("assistant", "Before archive", 1_000)],
      { transcriptMetadata: projectChatTranscriptMetadata(archived), mediaReadAllowed: false },
    );
    const { container, rerender } = threadFixture(props);
    rerender(true);
    expect(requireElement(container, ".chat-notice").textContent).toContain("Archived by Ada");

    props.transcriptMetadata = undefined;
    props.selectedSession = {
      ...archived,
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
    };
    rerender();
    expect(requireElement(container, ".chat-notice").textContent).toContain("Archived by Bob");
    props.selectedSession = { ...archived, archived: false };
    rerender();
    expect(container.querySelector(".chat-notice")).toBeNull();
    expect(container.querySelectorAll(".chat-bubble")).toHaveLength(1);
  });

  it.each([
    { path: "skills/review/SKILL.md", key: "click" },
    { path: "qa241-unicode/emoji-🌱.md", key: "click" },
    { path: "qa241-unicode/日本語.txt", key: "click" },
    { path: "qa241-unicode/日本語.txt", key: " " },
  ])("opens focused transcript file $path with $key", async ({ path, key }) => {
    const { container, onOpenWorkspaceFile, onOpenSessionLink, onHistoryIntent } =
      await linkFixture(`Inspect [Read file](${encodeURI(path)}:17)`);

    const link = container.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    link?.focus();
    expect(document.activeElement).toBe(link);
    expect(link?.hasAttribute("href")).toBe(false);
    if (key === "click") {
      link?.click();
    } else {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      link?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(onOpenWorkspaceFile).toHaveBeenCalledExactlyOnceWith({ path, line: 17 });
    expect(onOpenSessionLink).not.toHaveBeenCalled();
    expect(onHistoryIntent).not.toHaveBeenCalled();
  });

  it.each(["click", " "])("handles transcript session links with %j", async (action) => {
    const sessionKey = "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6";
    const { container, onOpenSessionLink, onHistoryIntent } = await linkFixture(
      `Open \`${sessionKey}\``,
    );

    const link = container.querySelector<HTMLAnchorElement>("a.markdown-session-link");
    if (action === "click") {
      link?.setAttribute("href", "/chat/roboclaw/2139bddb");
    } else {
      link?.focus();
    }
    activateLink(link, action);
    if (action !== "click") {
      expect(onHistoryIntent).not.toHaveBeenCalled();
    }
    expect(onOpenSessionLink).toHaveBeenCalledWith({ sessionKey, agentId: "roboclaw" });
  });

  it.each(["click", "Enter"])("SPA-routes transcript session hrefs with %s", async (action) => {
    const literalUuid = "12345678-90ab-cdef-1234-567890abcdef";
    const href = `/control/chat/main/~key/${literalUuid}?view=full#latest`;
    const { container, onOpenSessionLink, onHistoryIntent } = await linkFixture(
      `[Open session](${href})`,
      { basePath: "/control" },
    );

    const link = container.querySelector<HTMLAnchorElement>(`a[href^="/control/chat/"]`);
    activateLink(link, action);
    expect(onOpenSessionLink).toHaveBeenCalledWith({
      namespace: "chat",
      pathname: `/control/chat/main/~key/${literalUuid}`,
      search: "?view=full",
      hash: "#latest",
    });
    expect(onHistoryIntent).not.toHaveBeenCalled();
  });

  it("leaves external transcript hrefs to the browser", async () => {
    const { container, onOpenSessionLink } = await linkFixture(
      "[External session](https://example.com/chat/main/~key/12345678)",
    );

    const link = container.querySelector<HTMLAnchorElement>('a[href^="https://example.com/"]');
    const event = new MouseEvent("click", { bubbles: true, button: 0, cancelable: true });
    link?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onOpenSessionLink).not.toHaveBeenCalled();
  });
  function requireClosest(element: Element, selector: string): HTMLElement {
    return expectDefined(element.closest<HTMLElement>(selector), `closest ${selector}`);
  }

  function touchPointerUp(element: Element): void {
    const event = new Event("pointerup", { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    element.dispatchEvent(event);
  }

  function expectMetadata(groups: Element[], expected: boolean[]) {
    expect(groups.map((group) => group.classList.contains("chat-group--meta-revealed"))).toEqual(
      expected,
    );
  }

  async function searchFor(container: HTMLElement, query: string) {
    const input = await waitForSolid(() => requireElement(container, "input") as HTMLInputElement);
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("projects search changes without redraw callbacks or replacing its input", async () => {
    const paneId = "native-search-revision";
    const state = getTranscriptState(paneId);
    const container = transcriptContainer();
    render(renderTranscriptSearch(paneId), container);
    expect(container.querySelector("input")).toBeNull();
    state.search.toggle();
    const input = await waitForSolid(() => requireElement(container, "input") as HTMLInputElement);
    input.focus();
    state.search.setQuery("updated query");
    flush();
    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("updated query");
    expect(document.activeElement).toBe(input);
    state.search.close();
    flush();
    expect(container.querySelector("input")).toBeNull();
    render(null, container);
  });

  it("keeps live metadata absent while revealing stored metadata within each transcript", async () => {
    const first = threadFixture(
      threadProps(
        "pane-touch-first",
        "agent:main:first",
        ["First", "Second"].map((text, i) => message("user", text, 1_000 + 500 * i)),
        {
          stream: "Live reply",
          streamStartedAt: 2_000,
        },
      ),
    );
    const second = threadFixture(
      threadProps("touch-second", "agent:main:second", [
        message("assistant", "Other transcript", 3_000),
      ]),
    );
    first.renderOnly();
    second.renderOnly();
    first.transcript.start();
    second.transcript.start();
    first.transcript.update();
    second.transcript.update();
    await flushDeferredRowPrune();

    const storedGroup = requireElement(first.container, ".chat-group.user");
    const storedBubble = requireElement(storedGroup, ".chat-bubble");
    const streamBubble = requireElement(first.container, ".chat-bubble.streaming");
    const streamGroup = requireClosest(streamBubble, ".chat-group--with-footer");
    const secondGroup = requireElement(second.container, ".chat-group.assistant");

    storedBubble.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(false);

    const groups = [storedGroup, streamGroup, secondGroup];
    touchPointerUp(storedBubble);
    expectMetadata(groups, [true, false, false]);
    expect(storedGroup.classList.contains("chat-group--peer")).toBe(false);
    expect(storedGroup.querySelectorAll(".chat-bubble")).toHaveLength(2);
    const touches: [Element, boolean[]][] = [
      [requireElement(storedGroup, ".chat-bubble:last-child"), [false, false, false]],
      [storedBubble, [true, false, false]],
      [streamBubble, [false, true, false]],
      [requireElement(secondGroup, ".chat-bubble"), [false, true, true]],
      [requireElement(secondGroup, ".chat-copy-btn"), [false, true, true]],
      [requireElement(secondGroup, ".chat-bubble"), [false, true, false]],
    ];
    for (const [target, expected] of touches) {
      touchPointerUp(target);
      expectMetadata(groups, expected);
    }
    expect(streamGroup.querySelector(".chat-group-footer")?.childElementCount).toBe(0);
  });

  it("keeps the completed answer timestamp and actions when full run history is restored", async () => {
    vi.useFakeTimers();
    const runId = "answer-timestamp";
    const sessionKey = "agent:main:dashboard:answer-timestamp";
    const startedAt = Date.parse("2026-09-27T08:46:05.653Z");
    const answeredAt = Date.parse("2026-09-27T09:20:57.883Z");
    const text = "Confirmed: Engineers — café 雪 🦞";
    const user = message("user", "Confirm the audience.", startedAt - 1_000, {
      __openclaw: { id: "timestamp-prompt", idempotencyKey: `${runId}:user` },
    });
    const answer = message("assistant", text, answeredAt, {
      stopReason: "stop",
      __openclaw: { id: "timestamp-answer", runId, runTerminal: true },
    });
    const call = { type: "toolCall", id: "ask", name: "ask_user", arguments: {} };
    const work = [
      message("assistant", [call], startedAt, {
        stopReason: "toolUse",
        __openclaw: { id: "timestamp-call", runId },
      }),
      message("toolResult", "Engineers — café 雪 🦞", answeredAt - 1_000, {
        toolCallId: "ask",
        toolName: "ask_user",
        __openclaw: { id: "timestamp-result", runId },
      }),
    ];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onSetReply = vi.fn();
    for (const [index, messages] of [
      [user, answer],
      [user, ...work, answer],
    ].entries()) {
      const props = threadProps(`pane-answer-timestamp-${index}`, sessionKey, messages, {
        showToolCalls: true,
        onSetReply,
        selectedSession: {
          key: sessionKey,
          kind: "direct" as const,
          updatedAt: answeredAt,
          status: "done" as const,
          lastRunId: runId,
          runtimeMs: 35 * 60_000 + 17_000,
        },
      });
      const fixture = threadFixture(props);
      const { transcript, container, renderOnly: rerender } = fixture;
      rerender();
      transcript.start();
      transcript.update();
      await vi.advanceTimersByTimeAsync(0);
      const group = requireElement(container, ".chat-group.assistant");
      expect(group.querySelectorAll(".chat-group-footer")).toHaveLength(1);
      expect(group.querySelector("time")?.getAttribute("datetime")).toBe(
        "2026-09-27T09:20:57.883Z",
      );
      requireElement(group, ".chat-copy-btn").click();
      expect(writeText).toHaveBeenLastCalledWith(text);
      requireElement(group, ".chat-reply-btn").click();
      expect(onSetReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourceMessageId: "timestamp-answer", text }),
      );
      if (index === 1) {
        expect(requireElement(group, ".chat-work-group").textContent).toContain(
          "Worked for 35 minutes, 17 seconds",
        );
      }
      await vi.advanceTimersByTimeAsync(1_500);
      fixture.dispose();
    }
  });

  it.each(["indexed", "keyed"] as const)(
    "keeps a settled %s stream replyable while search separates its following tool row",
    async (kind) => {
      const paneId = `settled-reply-${kind}`;
      const sessionKey = "agent:main:main";
      const runId = "stream-reply-run";
      const text = "Settled summary";
      const onSetReply = vi.fn();
      const props = {
        ...threadProps(paneId, sessionKey, [
          message("user", "Inspect the workspace", 1_000, {
            __openclaw: { id: "stream-prompt", idempotencyKey: `${runId}:user` },
          }),
        ]),
        runId,
        runActive: true,
        runWorking: true,
        streamStartedAt: 2_000,
        showToolCalls: true,
        onSetReply,
        streamSegments: [
          {
            text,
            ts: 2_000,
            runId,
            ...(kind === "keyed" ? { itemId: "settled-segment" } : {}),
          },
        ],
        toolMessages: [
          message("toolResult", "Tool result", 3_000, {
            toolCallId: "following-read",
            toolName: "read",
            runId,
          }),
        ],
      };
      const { transcript, container, searchContainer, rerender } = threadFixture(
        props,
        createTestTranscript(),
        true,
      );
      rerender();
      toggleTranscriptSearch(paneId);
      flush();
      transcript.start();
      await searchFor(searchContainer, text);
      await flushDeferredRowPrune();

      const bubble = requireElement(container, ".chat-group.assistant .chat-bubble");
      const group = requireClosest(bubble, ".chat-group");
      const tool = requireElement(container, ".chat-group.tool");
      expect(bubble.textContent).toContain(text);
      expect(bubble.classList.contains("streaming")).toBe(false);
      expect(group.querySelector(".chat-group-footer-actions, .chat-reading-indicator")).toBeNull();
      expect(group.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      bubble.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const reply = requireElement(document, '.chat-reply-context-menu [role="menuitem"]');
      expect(reply.textContent).toBe("Reply");
      reply.click();

      expect(onSetReply.mock.calls).toEqual([
        [{ messageId: bubble.dataset.messageId, text, senderLabel: "Molty" }],
      ]);
    },
  );

  it.each([true, false])(
    "keeps completed commentary a turn block only outside search results (search %s)",
    async (search) => {
      const paneId = `commentary-${search}`;
      const text = "Checked the workspace layout.";
      const props = threadProps(paneId, "agent:main:main", [
        message("user", "Inspect the workspace", 1_000),
        message("assistant", [{ type: "text", text }], 2_000, {
          openclawStreamFallback: { replacementText: text, source: "segment", itemId: "layout" },
        }),
        message("assistant", "Workspace looks fine.", 3_000),
      ]);
      const { transcript, container, searchContainer, rerender } = threadFixture(
        props,
        createTestTranscript(),
        true,
      );
      if (search) {
        toggleTranscriptSearch(paneId);
      }
      transcript.start();
      rerender();
      if (search) {
        await searchFor(searchContainer, "workspace layout");
      }
      await flushDeferredRowPrune();

      const group = expectDefined(
        [...container.querySelectorAll<HTMLElement>(".chat-group.assistant")].find((element) =>
          element.textContent?.includes(text),
        ),
        "commentary group",
      );
      expect(group.classList.contains("chat-group--turn-block")).toBe(!search);
      expect(
        [
          ".chat-group-footer .chat-sender-name",
          ".chat-group-footer .chat-group-timestamp",
          ".chat-group-footer-actions .chat-copy-btn",
        ].map((selector) => group.querySelector(selector) !== null),
      ).toEqual([search, search, search]);
    },
  );
});
