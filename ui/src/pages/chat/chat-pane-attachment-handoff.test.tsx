/* @vitest-environment jsdom */

import { Show } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store-scope.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { selectFile } from "./chat-attachment-picker.test-support.ts";
import { storeChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { ChatPageRetainedSessions } from "./chat-page-retained-sessions.ts";
import {
  ChatPaneComposerHandoff,
  discardStateStagedAttachments,
  preparePaneStagedAttachments,
  restorePaneStagedAttachments,
} from "./chat-pane-attachment-handoff.ts";
import { registerChatPane } from "./chat-pane-elements.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import { enqueueChatMessage } from "./chat-queue.ts";
import {
  captureChatCommandComposerRecovery,
  settleChatCommandComposer,
} from "./chat-send-composer.ts";
import { createChatState } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatAttachmentControlsProps } from "./components/chat-attachment-controls.types.ts";
import { createChatAttachmentInputHandle } from "./components/chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "./components/chat-attachment-inputs.tsx";
import { AttachmentPreview } from "./components/chat-attachments.tsx";
import { reviewPrivateComposerDraft } from "./components/private-composer-recovery-dialog.tsx";
import {
  CHAT_COMPOSER_DRAFT_STORAGE_ERROR,
  loadChatComposerState,
} from "./composer-draft-storage.ts";
import { ChatComposerPersistence } from "./composer-persistence.ts";
import {
  activeQueuedMessageEdit,
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  isQueuedMessageBeingEdited,
  updateQueuedMessageEdit,
} from "./queued-message-edit.ts";
import { singlePaneLayout } from "./split-layout.ts";

const disposals: Array<() => void> = [];
afterEach(() => {
  disposals
    .splice(0)
    .toReversed()
    .forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function storedAttachment(id: string, mimeType = "image/png"): ChatAttachment {
  return registerChatAttachmentPayload({
    attachment: { id, mimeType },
    dataUrl: `data:${mimeType};base64,${id}`,
    file: new File([id], id, { type: mimeType }),
  });
}

function state(attachments: ChatAttachment[] = [], sessionKey = "agent:main:one") {
  return {
    agentsList: { defaultId: "main", mainKey: "main" },
    assistantAgentId: "main",
    chatAttachments: attachments,
    chatMessage: "",
    chatQueue: [],
    chatComposerFallbackByScope: {},
    hello: null,
    sessionKey,
    settings: { gatewayUrl: "ws://example.test" },
  } as unknown as ChatPageHost;
}

function composerFallback(attachments: ChatAttachment[], message = "", sequence = 1) {
  return { attachments, message, sequence, storageFailed: false };
}

function scope(current: ChatPageHost) {
  return resolveUiConversationIdentity(current, current.sessionKey);
}

function expectComposer(current: ChatPageHost, message: string, attachments: ChatAttachment[]) {
  expect([current.chatMessage, current.chatAttachments]).toEqual([message, attachments]);
}

function expectPayloads(retained: ChatAttachment[], released: ChatAttachment[] = []) {
  retained.forEach((attachment) => expect(getChatAttachmentDataUrl(attachment)).not.toBeNull());
  released.forEach((attachment) => expect(getChatAttachmentDataUrl(attachment)).toBeNull());
}

describe("cross-region Home composer ownership", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createStorageMock());
  });

  function presentation(
    context: ApplicationContext,
    owner: GatewayBrowserClient,
    region: "page" | "dock",
    sessionKey = "global",
    agentId = "main",
  ) {
    if (!context.chatAttachmentHandoff) {
      const stagedHandoff = createChatAttachmentHandoff(createApplicationGateway().gateway);
      Object.assign(context, { chatAttachmentHandoff: stagedHandoff });
      disposals.push(() => stagedHandoff.dispose());
    }
    const current = state([], sessionKey);
    current.assistantAgentId = agentId;
    current.client = owner;
    current.connected = false;
    const persistence = new ChatComposerPersistence(() => current);
    const controller = createChatState<ChatPageHost>({
      awaitDomCommit: async () => true,
    });
    current.canRestoreComposer = () => persistence.active;
    const notify = vi.fn(() => persistence.persistChangedState());
    const unsubscribeDraft = controller.composerDraft.subscribe(notify);
    current.composerDraftChanged = notify;
    persistence.start();
    const unsubscribe = chatOutboxOwner(current).subscribe(current);
    const view = { presented: true, owner };
    const handoff = new ChatPaneComposerHandoff(context, {
      state: () => current,
      owner: () => view.owner,
      presentationOwner: () => persistence.presentationOwner,
      region: () => region,
      presented: () => view.presented,
      pause: () => persistence.stop(),
      takeAttachmentReads: () => controller.takeAttachmentReads(),
      adoptAttachmentReads: (reads) => controller.adoptAttachmentReads(reads, current),
      resume: (restore) => {
        if (restore) {
          persistence.restore();
        }
        persistence.start();
      },
    });
    current.captureComposerRecoveryOwner = () => handoff.captureOwner();
    disposals.push(() => {
      handoff.dispose();
      unsubscribe();
      unsubscribeDraft();
      persistence.stop();
      controller.dispose();
      discardStateStagedAttachments(current);
    });
    return {
      current,
      persistence,
      controller,
      dispose: controller.dispose,
      notify,
      view,
      handoff,
      edit: (text: string, attachments = current.chatAttachments) => {
        current.chatMessage = text;
        current.chatAttachments = attachments;
        persistence.schedule();
        persistence.persistNow();
      },
    };
  }

  function home(
    sessionKey = "global",
    owner = { recoveryScope: "profile-a" } as GatewayBrowserClient,
  ) {
    const context = {} as ApplicationContext;
    return { context, owner, page: presentation(context, owner, "page", sessionKey) };
  }

  function captureCommand(current: ChatPageHost, attachments: ChatAttachment[] = []) {
    return captureChatCommandComposerRecovery(current, scope(current), {
      previousDraft: "/steer submitted",
      previousAttachments: attachments,
    });
  }

  function dockFrom({ context, owner, page }: ReturnType<typeof home>) {
    page.view.presented = false;
    const dock = presentation(context, owner, "dock", page.current.sessionKey);
    dock.handoff.claim();
    return dock;
  }

  function storedCommand(page: ReturnType<typeof presentation>, attachments: ChatAttachment[]) {
    storeChatComposerMemoryFallback(page.current, scope(page.current), {
      message: "/steer submitted",
      attachments,
    });
    return captureCommand(page.current, attachments);
  }

  function progress(
    reader: FileReader,
    owner: ReturnType<typeof presentation>,
    other: ReturnType<typeof presentation>,
    loaded: number,
  ) {
    owner.notify.mockClear();
    other.notify.mockClear();
    reader.dispatchEvent(
      new ProgressEvent("progress", { lengthComputable: true, loaded, total: 4 }),
    );
    expect(owner.notify).toHaveBeenCalledOnce();
    expect(other.notify).not.toHaveBeenCalled();
  }

  it.each(["complete", "remove"] as const)(
    "retains pending file custody through handoffs and source disposal (%s)",
    async (outcome) => {
      const fixture = home();
      const { context, owner, page } = fixture;
      page.edit("Keep this draft and file");
      const container = document.createElement("div");
      const inputHandle = createChatAttachmentInputHandle();
      const view = mountSolid(
        (props: { controls: ChatAttachmentControlsProps; showInputs: boolean }) => (
          <>
            <Show when={props.showInputs}>
              <ChatAttachmentInputs {...props.controls} inputHandle={inputHandle} />
            </Show>
            <AttachmentPreview {...props.controls} />
          </>
        ),
        { controls: page.controller.attachmentInputProps(page.current), showInputs: true },
        container,
      );
      const readers: FileReader[] = [];
      const read = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (
        this: FileReader,
      ) {
        readers.push(this);
      });
      disposals.push(() => {
        read.mockRestore();
        view.dispose();
      });
      const input = container.querySelector<HTMLInputElement>(".agent-chat__file-input")!;
      selectFile(input, new File(["pending payload"], "handoff.txt", { type: "text/plain" }));
      expect(page.controller.attachmentReads.pendingReads).toBe(1);
      const reader = readers[0]!;

      const dock = dockFrom(fixture);
      expect(dock.current.chatMessage).toBe("Keep this draft and file");
      expect(page.controller.attachmentReads.pendingReads).toBe(0);
      expect(dock.controller.attachmentReads.pendingReads).toBe(1);
      view.update({
        controls: dock.controller.attachmentInputProps(dock.current),
        showInputs: false,
      });
      await waitForSolid(() =>
        expect(container.querySelector('.chat-attachment-thumb[aria-busy="true"]')).not.toBeNull(),
      );

      dock.view.presented = false;
      page.view.presented = true;
      page.handoff.claim();
      expect(page.controller.attachmentReads.pendingReads).toBe(1);
      expect(dock.controller.attachmentReads.pendingReads).toBe(0);
      progress(reader, page, dock, 1);

      page.view.presented = false;
      dock.view.presented = true;
      dock.handoff.claim();
      page.handoff.dispose();
      page.dispose();
      expect(dock.controller.attachmentReads.pendingReads).toBe(1);
      progress(reader, dock, page, 2);
      view.update({
        controls: dock.controller.attachmentInputProps(dock.current),
        showInputs: false,
      });
      expect(
        container.querySelector<HTMLElement>(".chat-attachment-loading > span")?.style.transform,
      ).toBe("scaleX(0.5)");

      if (outcome === "remove") {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Remove handoff.txt"]')!
          .click();
        expect(dock.controller.attachmentReads.pendingReads).toBe(0);
      }

      const dataUrl = "data:text/plain;base64,cGVuZGluZyBwYXlsb2Fk";
      Object.defineProperty(reader, "result", { value: dataUrl });
      reader.dispatchEvent(new ProgressEvent("load"));
      expect(dock.controller.attachmentReads.pendingReads).toBe(0);
      expect(dock.current.chatAttachments.map(({ fileName }) => fileName)).toEqual(
        outcome === "complete" ? ["handoff.txt"] : [],
      );

      const returned = presentation(context, owner, "page");
      returned.handoff.claim();
      expect(returned.current.chatAttachments).toHaveLength(outcome === "complete" ? 1 : 0);
      if (outcome === "complete") {
        expect(getChatAttachmentDataUrl(returned.current.chatAttachments[0]!)).toBe(dataUrl);
      }
      expect(returned.current.chatMessage).toBe("Keep this draft and file");
    },
  );

  it.each(["text", "attachment"] as const)(
    "recovers a failed command through the current owner (%s)",
    (input) => {
      const fixture = home();
      const { page } = fixture;
      const submitted = storedAttachment(`command-${input}`, "text/plain");
      const recovery = captureCommand(page.current, [submitted]);
      const dock = dockFrom(fixture);
      const newer = input === "attachment" ? storedAttachment("newer-file", "text/plain") : null;
      const draft = input === "text" ? "Newer dock draft" : "";
      const attachments = newer ? [newer] : [];
      dock.edit(draft, attachments);

      settleChatCommandComposer(page.current, recovery, false, [submitted]);

      expect(page.current.chatMessage).toBe("");
      expectComposer(dock.current, draft, attachments);
      expect(getChatAttachmentDataUrl(submitted)).toBeNull();
      if (newer) {
        expect(getChatAttachmentDataUrl(newer)).not.toBeNull();
      }
      page.view.presented = true;
      page.handoff.claim();
      expectComposer(page.current, draft, attachments);
    },
  );

  it.each(["rejected", "accepted"] as const)(
    "settles a %s command through a dock after remounts",
    (result) => {
      const { context, owner, page } = home();
      const submitted = storedAttachment(`remounted-${result}`, "text/plain");
      const recovery = storedCommand(page, [submitted]);
      page.view.presented = false;
      const dock = presentation(context, owner, "dock");
      let currentPage = page;
      for (let index = 0; index < 2; index++) {
        currentPage.view.presented = false;
        dock.handoff.claim();
        currentPage.handoff.dispose();
        currentPage.persistence.stop();
        currentPage = presentation(context, owner, "page");
        currentPage.handoff.claim();
      }

      if (result === "accepted") {
        currentPage.edit("Keep this file", [submitted]);
      }
      settleChatCommandComposer(page.current, recovery, result === "accepted", [submitted]);

      const draft = result === "rejected" ? "/steer submitted" : "Keep this file";
      expectComposer(currentPage.current, draft, [submitted]);
      if (result === "accepted") {
        expect(currentPage.current.chatComposerFallbackByScope).toEqual({});
      }
      expect(getChatAttachmentDataUrl(submitted)).not.toBeNull();
      expect(page.current.chatMessage).toBe("");
      expect(dock.current.chatMessage).toBe("");
    },
  );

  it("keeps local command recovery when the Gateway has no handoff recovery scope", () => {
    const page = presentation({} as ApplicationContext, {} as GatewayBrowserClient, "page");
    const recovery = captureCommand(page.current);

    expect(recovery.owner).toBeUndefined();
    settleChatCommandComposer(page.current, recovery, false, []);
    expect(page.current.chatMessage).toBe("/steer submitted");
  });

  it("releases only unreferenced command payloads after every presentation unmounts", () => {
    const fixture = home();
    const { context, owner, page } = fixture;
    const staged = storedAttachment("staged-command", "text/plain");
    const fallback = storedAttachment("staged-fallback", "text/plain");
    const unreferenced = storedAttachment("completed-command", "text/plain");
    const recovery = captureCommand(page.current, [staged, fallback, unreferenced]);
    const dock = dockFrom(fixture);
    dock.edit("Current dock draft", [staged]);
    storeChatComposerMemoryFallback(dock.current, scope(page.current), {
      message: "Retained fallback",
      attachments: [fallback],
    });
    preparePaneStagedAttachments(
      context,
      "dock",
      dock.current,
      owner,
      dock.persistence.draftRevision,
    );
    page.handoff.dispose();
    dock.handoff.dispose();

    expect(recovery.owner?.resolveOwner()).toBeUndefined();
    settleChatCommandComposer(page.current, recovery, false, [staged, fallback, unreferenced]);
    expect(page.current.chatMessage).toBe("");

    expectPayloads([staged, fallback], [unreferenced]);
    context.chatAttachmentHandoff.clearPane("dock");
    expectPayloads([], [staged, fallback]);
  });

  it.each([
    ["replacement", "rejected"],
    ["replacement", "accepted"],
    ["reconnect", "rejected"],
  ] as const)(
    "requires the original connection after source disposal (%s, %s)",
    (connection, result) => {
      const fixture = home("global", {
        recoveryScope: "profile-a",
        connectionGeneration: 1,
      } as GatewayBrowserClient);
      const { owner, page } = fixture;
      const submitted = storedAttachment(`disposed-command-${connection}`, "text/plain");
      const recovery = storedCommand(page, [submitted]);
      const dock = dockFrom(fixture);
      page.handoff.dispose();
      page.persistence.stop();
      if (connection === "replacement") {
        const replacement = {
          recoveryScope: "profile-a",
          recoveryScopeReady: true,
        } as GatewayBrowserClient;
        dock.view.owner = replacement;
        dock.current.client = replacement;
      } else if (connection === "reconnect") {
        Object.defineProperty(owner, "connectionGeneration", { value: 2 });
        dock.current.connectionEpoch = 2;
      }

      settleChatCommandComposer(page.current, recovery, result === "accepted", [submitted]);
      expectComposer(dock.current, "", []);
      expect(
        dock.current.chatComposerFallbackByScope[storedChatOutboxScopeKey(scope(page.current))],
      ).toMatchObject({
        message: "/steer submitted",
        attachments: [submitted],
      });
      expect(getChatAttachmentDataUrl(submitted)).not.toBeNull();
    },
  );

  it("moves edited draft and file back to the already-retained Home after client rotation", () => {
    const sessionKey = "agent:main:main";
    const fixture = home(sessionKey, {
      recoveryScope: "profile-a",
      offlineRecoveryScope: "profile-a",
    } as GatewayBrowserClient);
    const { page } = fixture;
    page.edit("Home page draft");
    const dock = dockFrom(fixture);
    expect(dock.current.chatMessage).toBe("Home page draft");
    const file = storedAttachment(`roundtrip-${sessionKey}`, "text/plain");
    dock.edit("Edited in the dock", [file]);
    const queued = enqueueChatMessage(dock.current, "queued original")!;
    expect(beginQueuedMessageEdit(dock.current, queued.id)).toBe("started");
    updateQueuedMessageEdit(dock.current, "unfinished queue correction");
    const replacement = {
      recoveryScope: "profile-a",
      recoveryScopeReady: true,
    } as GatewayBrowserClient;
    for (const pane of [page, dock]) {
      pane.view.owner = replacement;
      pane.current.client = replacement;
    }

    // Relinquished persistence cannot overwrite the current presentation's edit.
    page.current.chatMessage = "stale retained draft";
    page.current.composerDraftChanged?.();
    expect(loadChatComposerState(dock.current, sessionKey).snapshot?.draft).toBe(
      "Edited in the dock",
    );
    page.view.presented = true;
    page.handoff.claim();
    dock.handoff.dispose();

    expectComposer(page.current, "Edited in the dock", [file]);
    expect(getChatAttachmentDataUrl(file)).not.toBeNull();
    expect(dock.current.chatAttachments).toEqual([]);
    expect(loadChatComposerState(page.current, sessionKey).snapshot?.draft).toBe(
      "Edited in the dock",
    );
    expect(activeQueuedMessageEdit(page.current)?.draftText).toBe("unfinished queue correction");
    expect(dock.current.chatQueuedEdit).toBeNull();
    expect(isQueuedMessageBeingEdited(dock.current, queued.id)).toBe(true);
    expect(cancelQueuedMessageEdit(page.current)).toBe(true);
    expect(isQueuedMessageBeingEdited(dock.current, queued.id)).toBe(false);
  });

  it.each(["agent", "session", "profile", "gateway", "unverified-rotation"] as const)(
    "does not transfer across a different %s owner",
    (difference) => {
      const { context, owner, page } = home();
      page.edit("Private Home draft");
      const resolveOwner = page.handoff.captureOwner();
      page.view.presented = false;
      if (difference === "profile") {
        Object.defineProperty(owner, "recoveryScope", { value: "profile-b" });
      }
      if (difference === "gateway") {
        page.current.settings = { gatewayUrl: "ws://different.test" } as ChatPageHost["settings"];
      }
      const nextOwner =
        difference === "unverified-rotation"
          ? ({
              recoveryScope: "profile-a",
              offlineRecoveryScope: "profile-a",
            } as GatewayBrowserClient)
          : owner;
      if (difference === "unverified-rotation") {
        page.view.owner = nextOwner;
        page.current.client = nextOwner;
      }
      const dock = presentation(
        context,
        nextOwner,
        "dock",
        difference === "session" ? "agent:main:other" : "global",
        difference === "agent" ? "research" : "main",
      );
      if (difference === "gateway") {
        dock.current.settings = page.current.settings;
      }

      dock.handoff.claim();

      expect(dock.current.chatMessage).toBe("");
      expect(page.current.chatMessage).toBe("Private Home draft");
      expect(resolveOwner?.resolveOwner()).not.toBe(dock.current);
    },
  );
});

describe("staged chat attachment pane handoff", () => {
  function handoffFixture() {
    const owner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff(createApplicationGateway().gateway);
    const context = { chatAttachmentHandoff: handoff } as unknown as ApplicationContext;
    disposals.push(() => handoff.dispose());
    return { owner, handoff, context };
  }

  function persistedComposer() {
    const current = state();
    const persistence = new ChatComposerPersistence(() => current);
    disposals.push(() => persistence.stop());
    return { current, persistence };
  }

  function retainedPane(sessions: SessionCapability) {
    const owner = {} as GatewayBrowserClient;
    const result = createTestChatPane({ client: owner, sessions });
    result.pane.paneId = "p2";
    const scopeKey = storedChatOutboxScopeKey(scope(result.state));
    return {
      ...result,
      owner,
      consume: () =>
        result.pane.context.chatAttachmentHandoff.consume({ owner, paneId: "p2", scopeKey }),
    };
  }

  function retainedSessions(
    context: ApplicationContext,
    pane: ReturnType<typeof createTestChatPane>["pane"],
  ) {
    const host = document.createElement("div");
    const element = Object.assign(pane.element, {
      paneId: pane.paneId,
      discardStagedAttachments: pane.discardStagedAttachments,
    });
    host.append(element);
    disposals.push(registerChatPane(element));
    return new ChatPageRetainedSessions(host, {
      context: () => context,
      presented: () => true,
      routeHref: () => window.location.href,
      layout: () => singlePaneLayout("c1", "p1", "main"),
      narrow: () => false,
      selectReplacement: () => {},
      adoptNavigation: () => {},
    });
  }

  it("does not restage a closed pane when its id is reused after disconnect", () => {
    const { pane, state: current, consume } = retainedPane({} as SessionCapability);
    const fallback = storedAttachment("closed-fallback");
    current.chatComposerFallbackByScope = {
      fallback: composerFallback([fallback], "closed pane draft"),
    };

    retainedSessions(pane.context, pane).discardPane(pane.paneId);
    const lateAttachment = storedAttachment("late-close-completion");
    current.chatAttachments.push(lateAttachment);
    pane.disconnectedCallback();

    expectPayloads([], [fallback, lateAttachment]);
    expect(consume()).toBeNull();
  });

  it("hands off new work after a retained closed pane is reactivated", () => {
    const { pane, state: current, owner, consume } = retainedPane(createSessionCapabilityFixture());
    pane.discardStagedAttachments?.();
    pane.resumeStagedAttachments?.();
    pane.connectedClient = null;
    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: owner,
      phase: "reconnecting",
      hello: null,
    });
    const reopened = storedAttachment("reopened");
    current.chatAttachments = [reopened];

    pane.disconnectedCallback();

    expect(consume()?.attachments).toEqual([reopened]);
    releaseChatAttachmentPayload(reopened.id);
  });

  it("rejects every part of an evicted composer after a newer split edit", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { owner, context } = handoffFixture();
    const { current: older, persistence: olderPersistence } = persistedComposer();
    const { current: newer, persistence: newerPersistence } = persistedComposer();
    const obsolete = storedAttachment("evicted-old-image");
    olderPersistence.start();
    older.chatMessage = "@Old goal";
    older.chatMentions = [{ profileId: "old", start: 0, end: 4 }];
    older.chatGoalDraftMode = { action: "start", sessionId: "old-session" };
    older.chatAttachments = [obsolete];
    olderPersistence.schedule();
    olderPersistence.persistNow();
    preparePaneStagedAttachments(context, "p1", older, owner, olderPersistence.draftRevision);
    newerPersistence.restore();
    newerPersistence.start();
    newer.chatMessage = "@New draft";
    newer.chatMentions = [{ profileId: "new", start: 0, end: 4 }];
    newer.chatGoalDraftMode = null;
    newerPersistence.schedule();
    newerPersistence.persistNow();
    const { current: remount, persistence: restoredPersistence } = persistedComposer();
    restoredPersistence.restore();
    restorePaneStagedAttachments(context, "p1", remount, owner);
    expectComposer(remount, "@New draft", []);
    expect([remount.chatMentions, remount.chatGoalDraftMode]).toEqual([newer.chatMentions, null]);
    expect(getChatAttachmentDataUrl(obsolete)).toBeNull();
  });

  it("keeps an unsaved composer and its recovery warning across eviction", () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const { owner, context } = handoffFixture();
    const { current: source, persistence } = persistedComposer();
    const image = storedAttachment("unsaved-image");
    persistence.start();
    source.chatMessage = "@Alex unsaved goal";
    source.chatMentions = [{ profileId: "alex", start: 0, end: 5 }];
    source.chatGoalDraftMode = { action: "start", sessionId: "unsaved-session" };
    source.chatAttachments = [image];
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    persistence.schedule();
    const result = persistence.persistForRouteSwitchResult();
    expect(result.status).toBe("storage-failed");
    if (result.status !== "storage-failed") {
      throw new Error("Expected failed storage");
    }
    storeChatComposerMemoryFallback(source, scope(source), {
      message: source.chatMessage,
      mentions: source.chatMentions,
      goalMode: source.chatGoalDraftMode,
      attachments: source.chatAttachments,
      draftRetry: result,
    });
    preparePaneStagedAttachments(context, "p1", source, owner, persistence.draftRevision);
    const remount = state([]);
    restorePaneStagedAttachments(context, "p1", remount, owner);
    expectComposer(remount, source.chatMessage, [image]);
    expect(remount.chatMentions).toEqual(source.chatMentions);
    expect(remount.chatGoalDraftMode).toEqual(source.chatGoalDraftMode);
    expect(remount.chatError).toBe(CHAT_COMPOSER_DRAFT_STORAGE_ERROR);
    expect(remount.chatComposerFallbackByScope).toEqual(source.chatComposerFallbackByScope);
    expect(getChatAttachmentDataUrl(image)).not.toBeNull();
    discardStateStagedAttachments(remount);
  });

  it("releases a restored fallback displaced by mounted state", () => {
    const { owner, handoff, context } = handoffFixture();
    const displaced = storedAttachment("displaced");
    const mounted = storedAttachment("mounted");
    const remount = state([]);
    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner,
      paneId: "p1",
      scopeKey: storedChatOutboxScopeKey(scope(remount)),
      attachments: [],
      fallbacks: {
        collision: composerFallback([displaced], "old"),
      },
    });
    remount.chatComposerFallbackByScope = {
      collision: composerFallback([mounted], "new", 2),
    };

    restorePaneStagedAttachments(context, "p1", remount, owner);

    expect(remount.chatComposerFallbackByScope.collision?.attachments).toEqual([mounted]);
    expectPayloads([mounted], [displaced]);
    discardStateStagedAttachments(remount);
  });
});
