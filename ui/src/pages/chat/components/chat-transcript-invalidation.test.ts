/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../../../app/theme-branding.ts";
import { resolveAvatarHat } from "../../../components/agent-avatar-hat.ts";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import * as draftStore from "../../../lib/chat/composer-draft-store.runtime.ts";
import * as messageNormalizer from "../../../lib/chat/message-normalizer.ts";
import * as videoPoster from "../../../lib/media/video-poster.ts";
import { PRESENTATION_CHANGED_EVENT } from "../../../lib/presentation.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  activePlacementSession,
  createInitializationContext,
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "../chat-pane.test-support.ts";
import * as chatThreadBuild from "../chat-thread-build.ts";
import {
  buildCachedChatItems,
  getExpandedToolCards,
  getExpandedUserMessages,
  getExpansionStateVersion,
  setExpansionState,
} from "../chat-thread.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import {
  render,
  renderChatThread,
  renderTranscriptSearch,
} from "../test-helpers/chat-transcript-native.tsx";
import { createAsyncQuestionPresentation } from "./chat-async-question.ts";
import * as chatMessage from "./chat-message-group-frame.ts";
import { releaseChatMediaResourceOwner } from "./chat-message-media.ts";
import { createAttachmentBlock } from "./chat-message.test-support.ts";
import {
  getTranscriptState,
  resetTranscriptSession,
  toggleTranscriptSearch,
} from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { transcriptContainer, threadFixture } from "./chat-transcript-fixture.test-support.tsx";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

const msg = <Content>(role: string, content: Content, timestamp = 1_000, extra = {}) => ({
  role,
  content,
  timestamp,
  ...extra,
});
const find = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);
const required = (root: ParentNode, selector: string) =>
  expectDefined(find(root, selector), selector);
const click = (root: ParentNode, selector: string) => required(root, selector).click();
const pending = (id: string, runId: string, content: unknown) => ({
  id,
  runId,
  acceptedAt: 3_000,
  state: "queued" as const,
  message: content,
});
const selectedSession = (
  props: ReturnType<typeof threadProps>,
  extra: Partial<NonNullable<typeof props.selectedSession>> = {},
) => ({ key: props.sessionKey, kind: "direct" as const, updatedAt: 1, ...extra });
function stubBlobUrls(blobUrl: string, revokeObjectURL = vi.fn()) {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = () => blobUrl;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
}
function updatingThread(props: ReturnType<typeof threadProps>) {
  const fixture = threadFixture(props);
  return {
    ...fixture,
    rerender: () => {
      fixture.rerender();
      fixture.transcript.update();
    },
  };
}

describe("chat transcript invalidation", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each(["ready", "delayed"])(
    "updates settled avatars when only the theme hat changes with a %s palette",
    (palette) => {
      const branding = resolveThemeBranding({ mascot: "claw", critters: [], avatarHat: "fedora" });
      const agentId = Array.from({ length: 100 }, (_, index) => `agent-${index}`).find((id) =>
        resolveAvatarHat(id, branding),
      )!;
      const props = threadProps("pane-avatar-hat", `agent:${agentId}:main`, [
        { role: "assistant", content: "Ready.", timestamp: 1_000 },
      ]);
      props.currentAgentId = agentId;
      props.selectedSession = selectedSession(props, { kind: "group" });
      props.branding = { ...branding, avatarHat: undefined };
      const { transcript, container, rerender } = threadFixture(props);
      const previousBranding = currentThemeBranding();
      try {
        setCurrentThemeBranding(props.branding);
        rerender();
        expect(find(container, ".identity-avatar--agent")).not.toBeNull();
        expect(find(container, ".identity-avatar__hat")).toBeNull();
        props.branding = branding;
        setCurrentThemeBranding(branding);
        rerender();
        expect(find(container, ".identity-avatar__hat--fedora")).not.toBeNull();
        props.branding = { ...branding, avatarHat: undefined };
        if (palette === "delayed") {
          rerender();
          expect(find(container, ".identity-avatar__hat--fedora")).not.toBeNull();
        }
        setCurrentThemeBranding(props.branding);
        rerender();
        expect(find(container, ".identity-avatar__hat")).toBeNull();
      } finally {
        setCurrentThemeBranding(previousBranding);
        render(null, container);
        transcript.dispose();
      }
    },
  );

  it.each(["session participants", "pending input"] as const)(
    "shows your name when a peer arrives through %s and keeps it while search hides the peer",
    async (peerSource) => {
      const paneId = `pane-sender-${peerSource}`;
      const self = { identity: { type: "profile" as const, id: "viewer" }, label: "Alex" };
      const peer = { identity: { type: "profile" as const, id: "peer" }, label: "Riley" };
      const ownMessage = msg("user", "Review my draft.", 1_000, {
        __openclaw: {
          id: "own-message",
          senderId: self.identity.id,
          senderIdentity: self.identity,
          senderName: self.label,
          transport: { clients: [{ id: "openclaw-control-ui", mode: "webchat" }] },
        },
      });
      const peerMessage = msg("user", "Check the example too.", 3_000, {
        __openclaw: {
          id: "peer-message",
          senderId: peer.identity.id,
          senderIdentity: peer.identity,
          senderName: peer.label,
        },
      });
      const props = threadProps(paneId, "agent:main:dashboard:sender-visibility", [
        ownMessage,
        { role: "assistant", content: "The draft looks good.", timestamp: 2_000 },
      ]);
      props.userId = self.identity.id;
      props.userName = self.label;
      props.selectedSession = selectedSession(props, {
        participants: [self, { identity: { type: "agent", id: "main" }, label: "Molty" }],
        participantCount: 2,
      });
      const { transcript, container } = threadFixture(props);
      const searchContainer = transcriptContainer();
      const rerender = () => {
        render(renderTranscriptSearch(paneId), searchContainer);
        render(renderChatThread({ ...props, mediaOwner: rerender }, transcript), container);
        transcript.update();
      };
      const ownName = () =>
        find(container, ".chat-group.user:not(.chat-group--peer) .chat-sender-name");
      try {
        rerender();
        transcript.start();
        await flushDeferredRowPrune();
        expect(container.textContent).toContain(ownMessage.content);
        expect(ownName()).toBeNull();
        expect(find(container, ".chat-message-source")).toBeNull();

        if (peerSource === "session participants") {
          props.selectedSession = {
            ...props.selectedSession,
            expandedParticipants: [...props.selectedSession.participants!, peer],
            participantCount: 3,
          };
        } else {
          props.pendingInputs = [pending("queued-peer", "peer-run", peerMessage)];
        }
        rerender();
        await flushDeferredRowPrune();
        expect(ownName()?.textContent).toBe("Alex");
        if (peerSource !== "session participants") {
          expect(find(container, ".chat-group--peer .chat-sender-name")?.textContent).toBe("Riley");
        }

        toggleTranscriptSearch(paneId);
        flush();
        const input = expectDefined(searchContainer.querySelector("input"), "search input");
        input.value = ownMessage.content;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await flushDeferredRowPrune();
        expect(container.textContent).toContain(ownMessage.content);
        expect(container.textContent).not.toContain(peerMessage.content);
        expect(ownName()?.textContent).toBe("Alex");
      } finally {
        transcript.dispose();
      }
    },
  );

  describe("user video previews", () => {
    const videoUrl = "https://cdn.example/recording.mp4";
    const onOpenSidebar = vi.fn();
    const revokeObjectURL = vi.fn();
    let props: ReturnType<typeof threadProps>;
    let transcript: ReturnType<typeof createTestTranscript>;
    let container: HTMLDivElement;

    beforeEach(() => {
      vi.spyOn(videoPoster, "requestVideoPoster").mockResolvedValue(new Blob(["poster"]));
      onOpenSidebar.mockClear();
      revokeObjectURL.mockClear();
      stubBlobUrls("blob:transcript-poster", revokeObjectURL);
      props = {
        ...threadProps("video-preview", "agent:main:video", [
          msg("user", [
            { type: "image", url: "/media/reference.png", alt: "Reference" },
            createAttachmentBlock(videoUrl, "video", "Recording.mp4", "video/mp4"),
            { type: "text", text: "Check this recording." },
          ]),
        ]),
        presented: false,
        transcriptVisible: true,
        onOpenSidebar,
      };
      container = transcriptContainer();
      transcript = createTestTranscript();
      transcript.start();
    });
    afterEach(() => {
      render(null, container);
      transcript.dispose();
    });
    async function renderPreview() {
      render(renderChatThread(props, transcript), container);
      transcript.update();
      await vi.dynamicImportSettled();
      if (props.transcriptVisible !== false) {
        await waitForSolid(() =>
          expect(find(container, ".chat-video-preview__content")).not.toBeNull(),
        );
      }
      await flushDeferredRowPrune();
    }

    it("places mixed user media above text and opens the video in Files without inline playback", async () => {
      await renderPreview();
      const bubble = find(container, ".chat-bubble--with-images");
      const gallery = bubble?.querySelector(":scope > .chat-message-images");
      expect(gallery?.querySelectorAll(".chat-image-frame")).toHaveLength(2);
      expect(gallery?.nextElementSibling?.textContent).toContain("Check this recording.");
      expect(find(container, "video, openclaw-chat-video-player")).toBeNull();
      gallery?.querySelector<HTMLButtonElement>(".chat-video-preview button")?.click();
      expect(onOpenSidebar).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "attachment", attachmentKind: "video", src: videoUrl }),
      );
    });

    it.each(["video", "image"])(
      "keeps an openable gallery card when %s decoding fails",
      async (stage) => {
        if (stage === "video") {
          vi.mocked(videoPoster.requestVideoPoster).mockResolvedValue(null);
        }
        await renderPreview();
        const frame = find(container, ".chat-video-preview");
        if (stage === "image") {
          expectDefined(frame?.querySelector("img"), "loaded video poster").dispatchEvent(
            new Event("error"),
          );
          flush();
        }
        expect(frame?.querySelector(".chat-assistant-attachment-card--compact")).toBeInstanceOf(
          HTMLElement,
        );
        frame?.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")?.click();
        expect(onOpenSidebar).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "attachment", src: videoUrl }),
        );
      },
    );

    it.each(["rendered", "parked"] as const)(
      "retains inactive previews and releases hidden rows with a %s parent",
      async (parent) => {
        const owner = new EventTarget();
        let visible = true;
        if (parent === "parked") {
          props.transcriptVisible = { owner, isPresented: () => visible };
        }
        await renderPreview();
        expect(find(container, ".chat-video-preview img")).toBeInstanceOf(HTMLImageElement);
        if (parent === "parked") {
          visible = false;
          owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
          resetTranscriptSession(props.paneId, container);
        } else {
          props.transcriptVisible = false;
          await renderPreview();
        }
        flush();
        expect(find(container, ".chat-video-preview img")).toBeNull();
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:transcript-poster");
        visible = true;
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        if (parent === "rendered") {
          props.transcriptVisible = true;
        }
        await renderPreview();
        expect(find(container, ".chat-video-preview img")).toBeInstanceOf(HTMLImageElement);
      },
    );
  });

  it("keeps explicit destinations stable as history, catalog rows, and sessions change", () => {
    const { pane } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
    const original = {
      role: "assistant",
      content: "PR acme/research#126 and https://github.com/other/project/issues/126. PR #126.",
      timestamp: 1_000,
    };
    const props = threadProps("pane-github", "agent:main:github", [original]);
    const { container, rerender } = threadFixture(props);
    const links = () =>
      [...container.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")].map(
        (a) => a.href,
      );
    const expected = [
      "https://github.com/acme/research/pull/126",
      "https://github.com/other/project/issues/126",
    ];
    rerender();
    expect(links()).toEqual(expected);
    for (const type of ["toolResult", "toolCall", "reasoning"] as const) {
      const catalogMessage = pane.catalogItemMessage({
        id: type,
        type,
        text: "https://github.com/unrelated/example/pull/126",
      });
      props.messages = [catalogMessage, original];
      rerender();
      expect(links()).toContain(expected[0]);
      expect(links()).toContain(expected[1]);
      expect(container.textContent).toContain("PR #126");
    }
    props.messages = [
      { role: "assistant", content: "https://github.com/history/older/pull/126", timestamp: 500 },
      original,
    ];
    rerender();
    expect(links()).toContain(expected[0]);
    expect(links()).toContain(expected[1]);
    props.sessionKey = "agent:main:another-checkout";
    props.messages = [original];
    rerender();
    expect(links()).toEqual(expected);
  });

  it("does not renormalize projected historical messages", () => {
    const sessionKey = "agent:main:dashboard:history";
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Historical message ${index}`,
      timestamp: index + 1,
      __openclaw: { id: `message-${index}` },
    }));
    const transcript = createTestTranscript();
    const props = threadProps("pane-offscreen-history", sessionKey, messages);
    const project = () =>
      transcript.renderSession(sessionKey, (session) => {
        projectChatTranscript(props, session);
        return null;
      });
    project();

    const normalizeSpy = vi.spyOn(messageNormalizer, "normalizeMessage");
    project();

    const historicalMessages = new Set<unknown>(messages);
    expect(normalizeSpy.mock.calls.some(([message]) => historicalMessages.has(message))).toBe(
      false,
    );
  });

  it("keeps settled run frames idle during stream updates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(60_000);
    const completedRunId = "settled-run";
    const activeRunId = "active-run";
    const props = {
      ...threadProps("pane-settled-stream-only", "agent:main:dashboard:settled", [
        msg("user", "Inspect the workspace", 1_000, {
          __openclaw: { id: "settled-user", idempotencyKey: `${completedRunId}:user` },
        }),
        msg("toolResult", "Read complete", 2_000, {
          toolCallId: "settled-read",
          toolName: "read",
          runId: completedRunId,
        }),
        msg("assistant", "Workspace checked", 3_000, {
          phase: "final_answer",
          stopReason: "stop",
          runId: completedRunId,
          __openclaw: { id: "settled-final" },
        }),
        msg("user", "Continue with the next task", 4_000, {
          __openclaw: { id: "active-user", idempotencyKey: `${activeRunId}:user` },
        }),
      ]),
      showToolCalls: true,
      runId: activeRunId,
      runActive: true,
      runWorking: true,
      stream: "Draft next reply",
      streamStartedAt: 5_000,
    };
    const { transcript, container, rerender } = updatingThread(props);
    const prepareFrame = vi.spyOn(chatMessage, "prepareMessageGroupFrame");
    try {
      rerender();
      transcript.start();
      await flushDeferredRowPrune();
      const finalBubble = required(container, '[data-entry-id="settled-final"]');
      const workToggle = expectDefined(
        finalBubble.closest(".chat-group")?.querySelector(".chat-work-group button"),
        "completed work disclosure",
      );
      expect(workToggle.getAttribute("aria-expanded")).toBe("false");
      expect(find(container, ".chat-bubble.streaming")?.textContent).toContain(props.stream);
      expect(prepareFrame.mock.calls.some(([group]) => group.runId === completedRunId)).toBe(true);
      prepareFrame.mockClear();
      props.stream = "Advanced next reply";
      rerender();

      expect(find(container, ".chat-bubble.streaming")?.textContent).toContain(props.stream);
      expect(find(container, '[data-entry-id="settled-final"]')).toBe(finalBubble);
      expect(finalBubble.textContent).toContain("Workspace checked");
      expect(workToggle.getAttribute("aria-expanded")).toBe("false");
      expect(prepareFrame.mock.calls.filter(([group]) => group.runId === completedRunId)).toEqual(
        [],
      );
    } finally {
      transcript.dispose();
    }
  });

  it("keeps built row identities across an A to B to A presentation reset", () => {
    const paneId = "pane-session-items";
    const messagesA = [{ role: "assistant", content: "session A", timestamp: 1_000 }];
    const messagesB = [{ role: "assistant", content: "session B", timestamp: 2_000 }];
    const stableInputs = {
      paneId,
      runId: null,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    };
    const buildSpy = vi.spyOn(chatThreadBuild, "buildChatItems");
    const build = (sessionKey: string, messages: unknown[]) =>
      buildCachedChatItems({
        ...stableInputs,
        sessionKey,
        messages,
      });
    const itemsA = build("agent:main:session-a", messagesA);
    resetTranscriptSession(paneId);
    build("agent:main:session-b", messagesB);
    resetTranscriptSession(paneId);
    const restoredItemsA = build("agent:main:session-a", messagesA);
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(restoredItemsA).toBe(itemsA);
  });

  it("keeps message rows prepared and refreshes failure actions when a retained transcript returns", async () => {
    const owner = new EventTarget();
    let visible = true;
    const props = {
      ...threadProps("pane-retained-rows", "agent:main:retained-rows", [
        msg("user", "Keep this question", 1_000),
        msg("assistant", "Keep this answer", 2_000),
        msg("custom", "The service is unavailable.", 3_000, {
          openclawRunError: { runId: "run-a", summary: "The service is unavailable." },
        }),
      ]),
      transcriptVisible: { owner, isPresented: () => visible },
      presented: true,
      failureActionsRunId: "run-a",
      onRetryRun: vi.fn(),
    };
    const { transcript, container, rerender } = updatingThread(props);
    const prepare = vi.spyOn(chatMessage, "prepareMessageGroupFrame");
    try {
      rerender();
      transcript.start();
      await flushDeferredRowPrune();
      await waitForSolid(() => expect(find(container, ".chat-run-failure__retry")).not.toBeNull());
      const bubble = required(container, ".chat-bubble");
      expect(prepare).toHaveBeenCalled();
      prepare.mockClear();
      const previousRetry = props.onRetryRun;

      visible = false;
      props.presented = false;
      owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
      resetTranscriptSession(props.paneId, container);
      rerender();
      flush();
      visible = true;
      props.presented = true;
      props.subagentSessions = [{ key: "agent:main:child", kind: "direct", updatedAt: 3_000 }];
      owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
      props.onRetryRun = vi.fn();
      rerender();
      await flushDeferredRowPrune();

      expect(required(container, ".chat-bubble")).toBe(bubble);
      expect(container.textContent).toContain("Keep this answer");
      expect(prepare).not.toHaveBeenCalled();
      click(container, ".chat-run-failure__retry");
      expect(props.onRetryRun).toHaveBeenCalledExactlyOnceWith("run-a");
      expect(previousRetry).not.toHaveBeenCalled();

      props.failureActionsRunId = "run-b";
      rerender();
      await flushDeferredRowPrune();
      expect(find(container, ".chat-run-failure__retry")).toBeNull();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      render(null, container);
      transcript.dispose();
    }
  });

  it.each([false, true])(
    "refreshes a retained question's Answer action (durable=%s)",
    async (durable) => {
      vi.spyOn(draftStore, "readDurableComposerDraft").mockResolvedValue({ status: "not-found" });
      vi.spyOn(draftStore, "writeDurableComposerDraft").mockResolvedValue({ status: "persisted" });
      const props = threadProps("pane-retained-question", "agent:main:retained-question", [
        msg("assistant", "Which audience?", 1_000, {
          runId: "question-run",
          openclawAsyncDelivery: {
            itemId: "audience-question",
            questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
          },
        }),
        msg("assistant", "First turn finished.", 1_500, {
          runId: "question-run",
          phase: "final_answer",
          stopReason: "stop",
          __openclaw: { id: "question-completed", runId: "question-run", runTerminal: true },
        }),
        msg("assistant", "Finished the requested work.", 2_000, {
          runId: "completed-run",
          phase: "final_answer",
          stopReason: "stop",
          __openclaw: { id: "completed", runId: "completed-run", runTerminal: true },
        }),
      ]);
      const state = getTranscriptState(props.paneId);
      const onReopen = vi.fn();
      const presentQuestions = () => {
        props.asyncQuestions = createAsyncQuestionPresentation(state, {
          sessionKey: props.sessionKey,
          messages: props.messages,
          onAsyncQuestionSubmit: vi.fn(async () => true),
          asyncQuestionStorage: durable
            ? { gatewayOwner: "ws://fixture", recoveryScope: "viewer", scopeKey: props.sessionKey }
            : null,
          onReopen,
        });
      };
      presentQuestions();
      for (const session of state.asyncQuestionSessions?.values() ?? []) {
        await session.load;
      }
      const { transcript, container, rerender } = updatingThread(props);
      try {
        rerender();
        transcript.start();
        await flushDeferredRowPrune();
        expect(required(container, ".chat-question-summary button").textContent).toBe("Answer");

        resetTranscriptSession(props.paneId, container);
        presentQuestions();
        rerender();
        await flushDeferredRowPrune();
        click(container, ".chat-question-summary button");

        expect(onReopen).toHaveBeenCalledWith("audience-question", expect.any(String));
      } finally {
        for (const session of state.asyncQuestionSessions?.values() ?? []) {
          await session.write;
        }
        render(null, container);
        transcript.dispose();
      }
    },
  );

  it("keeps history cached during worker setup and clears its notice when placement becomes active", async () => {
    const props = threadProps("pane-worker-setup", "agent:main:worker-setup", [
      { role: "user", content: "Earlier request", timestamp: 1_000 },
      { role: "assistant", content: "Earlier reply", timestamp: 2_000 },
    ]);
    props.pendingInputs = [
      pending("queued-follow-up", "queued-run", msg("user", "Queued follow-up", 3_000)),
    ];
    const timing = { generation: 1, createdAtMs: 1, updatedAtMs: 1, stateChangedAtMs: 1 };
    props.selectedSession = selectedSession(props, {
      placement: { state: "requested", ...timing },
    });
    const { transcript, container, rerender } = updatingThread(props);
    const buildSpy = vi.spyOn(chatThreadBuild, "buildChatItems");
    try {
      rerender();
      transcript.start();
      await flushDeferredRowPrune();
      expect(container.textContent).toContain("Received · waiting for worker setup");
      expect(container.querySelectorAll('[data-message-text="Queued follow-up"]')).toHaveLength(1);
      expect(buildSpy).toHaveBeenCalledOnce();

      rerender();
      expect(buildSpy).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("Received · waiting for worker setup");

      props.selectedSession = {
        ...props.selectedSession,
        placement: {
          ...activePlacementSession(props.sessionKey).placement,
          environmentId: "worker:fixture",
        },
      };
      rerender();
      expect(buildSpy).toHaveBeenCalledTimes(2);
      expect(container.textContent).not.toContain("Received · waiting for worker setup");
      expect(container.querySelectorAll('[data-message-text="Queued follow-up"]')).toHaveLength(1);
    } finally {
      transcript.dispose();
    }
  });

  it("keeps settled rows idle across session metadata updates but refreshes their identity gutter", async () => {
    vi.spyOn(Date, "now").mockReturnValue(60_000);
    const props = threadProps("pane-session-metadata", "agent:main:main", [
      { role: "user", senderLabel: "Alex", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
    props.selectedSession = selectedSession(props);
    const { container, rerender } = threadFixture(props);
    const prepareFrame = vi.spyOn(chatMessage, "prepareMessageGroupFrame");
    rerender();
    await flushDeferredRowPrune();
    const userRow = required(container, ".chat-group.user");
    expect(userRow.querySelector(".chat-avatar")).toBeNull();
    expect(prepareFrame.mock.calls.some(([group]) => group.role === "user")).toBe(true);
    prepareFrame.mockClear();

    props.selectedSession = { ...props.selectedSession, updatedAt: 2, label: "Renamed chat" };
    rerender();
    expect(prepareFrame).not.toHaveBeenCalled();
    expect(find(container, ".chat-group.user")).toBe(userRow);

    props.selectedSession = { ...props.selectedSession, kind: "group" };
    rerender();
    await waitForSolid(() => {
      expect(userRow.isConnected).toBe(true);
      expect(find(container, ".chat-group.user")).toBe(userRow);
      expect(userRow.querySelector(".chat-avatar")).not.toBeNull();
    });
  });

  it("rechecks visible images when the same session changes workspace protection", async () => {
    const source = "/outside/project/policy-preview.png";
    const props = threadProps("pane-media-policy", "agent:main:media-policy", [
      msg("assistant", [{ type: "image", url: source, alt: "Policy preview" }]),
    ]);
    props.selectedSession = selectedSession(props, { permissionMode: "full" });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () =>
        props.selectedSession?.permissionMode === "full"
          ? {
              available: true,
              mediaTicket: "full-access-image",
              mediaTicketExpiresAt: new Date(Date.now() + 90_000).toISOString(),
            }
          : {
              available: false,
              reason: "Outside allowed folders",
              canAllow: true,
              retryable: false,
            },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { transcript, container, rerender } = updatingThread(props);
    props.mediaOwner = rerender;
    rerender();
    transcript.start();
    transcript.update();
    await flushDeferredRowPrune();
    expect(find(container, "img.chat-message-image")).not.toBeNull();

    for (const permissionMode of ["workspace", "full", "workspace"] as const) {
      props.selectedSession = { ...props.selectedSession, permissionMode };
      rerender();
      await flushDeferredRowPrune();
      expect(Boolean(find(container, "img.chat-message-image"))).toBe(permissionMode === "full");
      if (permissionMode === "workspace") {
        expect(find(container, ".chat-assistant-attachment-card")?.textContent).toContain(
          "Allow image",
        );
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    releaseChatMediaResourceOwner(rerender);
    transcript.dispose();
  });

  it("rebinds guarded transcript images when the gateway rotates its auth token", async () => {
    const blobUrl = `blob:transcript-media-${crypto.randomUUID()}`;
    stubBlobUrls(blobUrl);

    let previousSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_source: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          previousSignal = init?.signal ?? undefined;
          previousSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("media scope changed", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve({
        ok: true,
        blob: async () => new Blob(["png"], { type: "image/png" }),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const transcript = createTestTranscript();
    const container = transcriptContainer();
    const client = {
      request: vi.fn(async () => null),
    } as unknown as Parameters<typeof createTestChatPane>[0]["client"];
    const sessions = createSessionCapabilityFixture();
    const { pane, state } = createTestChatPane({ client, sessions });
    const applyToken = (deviceToken: string) =>
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        client,
        phase: "connected",
        hello: {
          ...pane.context.gateway.snapshot.hello,
          auth: { deviceToken },
        } as typeof state.hello,
      });
    applyToken("test-auth-token");
    const messages = [msg("assistant", [{ type: "image", url: source }])];
    const mediaOwner = {};
    const view = mountSolid(
      () => {
        const gateway = projectOwner(
          pane.context.gateway,
          (owner) => owner.snapshot.hello,
          Object.is,
        );
        return createComponent(ChatThread, {
          get props() {
            return {
              ...threadProps("pane-gateway-media-auth", state.sessionKey, messages),
              assistantAttachmentAuthToken: resolveControlUiAuthToken({ hello: gateway.read() }),
              mediaOwner,
            };
          },
          transcript,
        });
      },
      { container },
    );
    onTestFinished(view.unmount);
    transcript.start();
    transcript.update();
    await flushDeferredRowPrune();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer test-auth-token",
    );
    expect(previousSignal?.aborted).toBe(false);
    expect(find(container, ".chat-message-image")).toBeNull();

    applyToken("test-token");
    flush();
    expect(previousSignal?.aborted).toBe(true);
    await flushDeferredRowPrune();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
    expect(container.querySelector<HTMLImageElement>(".chat-message-image")?.src).toBe(blobUrl);

    releaseChatMediaResourceOwner(mediaOwner);
    transcript.dispose();
  });

  it("updates MCP App pinning when the same provider's capability changes", async () => {
    await import("../../../components/mcp-app-view.tsx");
    const provider = {
      sessionKey: "agent:main:main",
      canPinWidgets: true,
      canPinMcpApps: false,
      pinMcpApp: vi.fn(async () => undefined),
      snapshot$: {
        value: {
          sessionKey: "agent:main:main",
          revision: 1,
          tabs: [],
          widgets: [],
        },
        subscribe: () => () => undefined,
      },
    };
    const props = {
      ...threadProps("pane-mcp-capability"),
      boardProvider: provider as unknown as BoardProvider,
      messages: [
        msg("assistant", [
          {
            type: "canvas",
            preview: {
              kind: "canvas",
              surface: "assistant_message",
              render: "url",
              viewId: "outer-view-must-not-be-pinned",
              mcpApp: { viewId: "view-dashboard-app" },
            },
          },
        ]),
      ],
    };
    const transcript = createTestTranscript();
    const container = document.body.appendChild(
      createApplicationContextProvider(createInitializationContext()),
    );
    onTestFinished(() => {
      render(null, container);
      transcript.dispose();
      container.remove();
    });

    render(renderChatThread(props, transcript), container);
    transcript.start();
    transcript.update();
    await vi.dynamicImportSettled();
    await flushDeferredRowPrune();

    await waitForSolid(() =>
      expect(find(container, '[data-content-kind="mcp-app"]')).not.toBeNull(),
    );
    expect(find(container, "[data-pin-widget]")).toBeNull();

    for (const canPin of [true, false]) {
      provider.canPinMcpApps = canPin;
      render(renderChatThread(props, transcript), container);
      transcript.update();
      expect(find(container, "[data-pin-widget]") !== null).toBe(canPin);
      expect(provider.snapshot$.value.revision).toBe(1);
    }
  });

  it("keeps mounted disclosure handlers attached to recreated session expansion maps", async () => {
    const sessionKey = "retained-session";
    const props = {
      ...threadProps("retained-pane", sessionKey, [
        { role: "user", content: "long user message ".repeat(100), timestamp: 1 },
        msg(
          "assistant",
          [
            { type: "text", text: "assistant reply" },
            { type: "toolcall", id: "retained-call", name: "browser.open" },
          ],
          2,
        ),
      ]),
      showToolCalls: true,
    };
    const controller = createTestTranscript();
    const retainedPane = transcriptContainer();
    controller.start();
    render(renderChatThread(props, controller), retainedPane);
    controller.update();
    await flushDeferredRowPrune();
    await settleToolBridges(retainedPane);
    const staleTools = getExpandedToolCards(sessionKey);
    const staleUsers = getExpandedUserMessages(sessionKey);
    const previousToolVersion = getExpansionStateVersion(staleTools);
    const previousUserVersion = getExpansionStateVersion(staleUsers);

    for (let index = 0; index < 20; index += 1) {
      const alternate = threadFixture({
        ...props,
        paneId: `alternate-pane-${index}`,
        sessionKey: `alternate-session-${index}`,
      });
      alternate.rerender();
      await settleToolBridges(alternate.container);
    }

    render(renderChatThread(props, controller), retainedPane);
    await settleToolBridges(retainedPane);
    const currentTools = getExpandedToolCards(sessionKey);
    const currentUsers = getExpandedUserMessages(sessionKey);
    expect(currentTools).not.toBe(staleTools);
    expect(currentUsers).not.toBe(staleUsers);
    expect(getExpansionStateVersion(currentTools)).toBe(previousToolVersion);
    expect(getExpansionStateVersion(currentUsers)).toBe(previousUserVersion);
    const toolCardId = expectDefined(currentTools.keys().next().value, "retained tool card");
    click(retainedPane, ".chat-group.user .chat-message-disclosure__toggle");
    click(retainedPane, ".chat-tool-msg-summary");
    expect(currentTools.get(toolCardId)).toBe(true);
    expect(staleTools.get(toolCardId)).toBe(false);
    expect(currentUsers.size).toBe(1);
    expect(staleUsers.size).toBe(0);

    const visibleSession = "tool-visibility-session";
    const visibleProps = {
      ...props,
      paneId: "tool-visibility-pane",
      sessionKey: visibleSession,
      transcriptVisible: true,
      messages: [
        { role: "user", content: "tool visibility prompt", timestamp: 1 },
        msg("toolResult", "Expanded tool result", 2, {
          toolCallId: "expanded-tool",
          toolName: "browser.open",
        }),
        { role: "assistant", content: "The first tool completed.", timestamp: 3 },
        { role: "user", content: "Show the next tool result.", timestamp: 4 },
        msg("toolResult", "Collapsed tool result", 5, {
          toolCallId: "collapsed-tool",
          toolName: "browser.open",
        }),
      ],
    };
    saveChatSessionScrollPosition(visibleProps.paneId, visibleSession, {
      scrollTop: 0,
      anchorToEnd: false,
    });
    const visibleTranscript = createTestTranscript(visibleProps.paneId);
    onTestFinished(() => visibleTranscript.dispose());
    const visiblePane = transcriptContainer();
    const drawVisible = async (next = visibleProps) => {
      render(renderChatThread(next, visibleTranscript), visiblePane);
      visibleTranscript.update();
      await settleToolBridges(visiblePane);
    };
    await drawVisible();
    visibleTranscript.start();
    const visibilityState = getExpandedToolCards(visibleSession);
    const visibilityIds = [...visibilityState.keys()].filter((key) => key.startsWith("toolmsg:"));
    const expandedId = expectDefined(visibilityIds[0], "expanded standalone tool disclosure");
    const collapsedId = expectDefined(visibilityIds[1], "collapsed standalone tool disclosure");
    const buttons = () =>
      Array.from(visiblePane.querySelectorAll<HTMLButtonElement>(".chat-tool-msg-summary")).filter(
        (button) => !button.closest(".chat-tool-msg-body"),
      );
    const expansion = () => buttons().map((button) => button.getAttribute("aria-expanded"));
    const expectExpansion = (...values: string[]) =>
      waitForSolid(() => expect(expansion()).toEqual(values));
    await waitForSolid(() => expect(buttons()).toHaveLength(2));
    expect(expansion()).toEqual(["false", "false"]);
    expectDefined(buttons()[0], "first mounted tool disclosure").click();
    await expectExpansion("true", "false");
    expectDefined(buttons()[1], "second mounted tool disclosure").click();
    await expectExpansion("true", "true");
    expectDefined(buttons()[1], "second mounted tool disclosure").click();
    await expectExpansion("true", "false");

    await drawVisible({ ...visibleProps, transcriptVisible: false });
    setExpansionState(visibilityState, expandedId, false);
    flush();
    expect(buttons()[0]?.getAttribute("aria-expanded")).toBe("true");
    await drawVisible();
    expect(buttons()[0]?.getAttribute("aria-expanded")).toBe("false");
    setExpansionState(visibilityState, expandedId, true);
    await waitForSolid(() => expect(buttons()[0]?.getAttribute("aria-expanded")).toBe("true"));

    await drawVisible({ ...visibleProps, showToolCalls: false });
    expect(buttons()).toHaveLength(0);
    await drawVisible();

    expect(buttons()).toHaveLength(2);
    expect(expansion()).toEqual(["true", "false"]);
    expect(visibilityState.get(expandedId)).toBe(true);
    expect(visibilityState.get(collapsedId)).toBe(false);
    await drawVisible({
      ...visibleProps,
      messages: visibleProps.messages.filter(
        (message) => !("toolCallId" in message && message.toolCallId === "expanded-tool"),
      ),
    });
    expect(visibilityState.get(expandedId)).toBe(true);
    expect(visibilityState.get(collapsedId)).toBe(false);
  });
});
