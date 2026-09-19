/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "./attachment-payload-store.ts";
import { storeChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import {
  closeStagedPane,
  ChatPaneComposerHandoff,
  discardStateStagedAttachments,
  preparePaneStagedAttachments,
  replacePaneStagedAttachmentGatewayOwner,
  restorePaneStagedAttachments,
} from "./chat-pane-attachment-handoff.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { enqueueChatMessage, subscribeChatOutboxProjection } from "./chat-queue.ts";
import {
  captureChatCommandComposerRecovery,
  settleChatCommandComposer,
} from "./chat-send-composer.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  ChatComposerPersistence,
  CHAT_COMPOSER_DRAFT_STORAGE_ERROR,
  loadChatComposerSnapshot,
  storedChatOutboxScopeKey,
} from "./composer-persistence.ts";
import {
  activeQueuedMessageEdit,
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  isQueuedMessageBeingEdited,
  updateQueuedMessageEdit,
} from "./queued-message-edit.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";

function storedAttachment(id: string, mimeType = "image/png"): ChatAttachment {
  return registerChatAttachmentPayload({
    attachment: { id, mimeType },
    dataUrl: `data:${mimeType};base64,${id}`,
    file: new File([id], id, { type: mimeType }),
  });
}

function state(attachments: ChatAttachment[], sessionKey = "agent:main:one") {
  return {
    agentsList: { defaultId: "main", mainKey: "main" },
    assistantAgentId: "main",
    chatAttachments: attachments,
    chatComposerFallbackByScope: {},
    hello: null,
    sessionKey,
    settings: { gatewayUrl: "ws://example.test" },
  } as unknown as ChatPageHost;
}

describe("cross-region Home composer ownership", () => {
  const disposals: Array<() => void> = [];
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createStorageMock());
  });
  afterEach(() => {
    for (const dispose of disposals.splice(0).toReversed()) {
      dispose();
    }
    vi.unstubAllGlobals();
  });

  function presentation(
    context: ApplicationContext,
    owner: GatewayBrowserClient,
    region: "page" | "dock",
    sessionKey = "global",
    agentId = "main",
  ) {
    if (!context.chatAttachmentHandoff) {
      const stagedHandoff = createChatAttachmentHandoff();
      Object.assign(context, { chatAttachmentHandoff: stagedHandoff });
      disposals.push(() => stagedHandoff.dispose());
    }
    const current = state([], sessionKey);
    current.assistantAgentId = agentId;
    current.client = owner;
    current.connected = false;
    current.chatMessage = "";
    current.chatQueue = [];
    const persistence = new ChatComposerPersistence(() => current);
    current.canRestoreComposer = () => persistence.active;
    current.requestUpdate = () => persistence.persistChangedState();
    persistence.start();
    const unsubscribe = subscribeChatOutboxProjection(current);
    const view = { presented: true, owner };
    const handoff = new ChatPaneComposerHandoff(context, {
      state: () => current,
      owner: () => view.owner,
      region: () => region,
      presented: () => view.presented,
      pause: () => persistence.stop(),
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
      persistence.stop();
      discardStateStagedAttachments(current);
    });
    return {
      current,
      persistence,
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

  it.each(["empty", "text", "attachment"] as const)(
    "recovers a failed command through the current Home owner with %s input",
    (input) => {
      const context = {} as ApplicationContext;
      const owner = { recoveryScope: "profile-a" } as GatewayBrowserClient;
      const page = presentation(context, owner, "page");
      const submitted = storedAttachment(`command-${input}`, "text/plain");
      const recovery = captureChatCommandComposerRecovery(
        page.current,
        resolveUiConversationIdentity(page.current, page.current.sessionKey),
        { draft: "/steer submitted", attachments: [submitted] },
      );
      page.view.presented = false;
      const dock = presentation(context, owner, "dock");
      dock.handoff.claim();
      const newer = input === "attachment" ? storedAttachment("newer-file", "text/plain") : null;
      if (input !== "empty") {
        dock.edit(input === "text" ? "Newer dock draft" : "", newer ? [newer] : []);
      }

      settleChatCommandComposer(page.current, recovery, false, [submitted]);

      expect(page.current.chatMessage).toBe("");
      expect(dock.current.chatMessage).toBe(
        input === "empty" ? "/steer submitted" : input === "text" ? "Newer dock draft" : "",
      );
      expect(dock.current.chatAttachments).toEqual(
        input === "empty" ? [submitted] : newer ? [newer] : [],
      );
      expect(getChatAttachmentDataUrl(submitted)).toBe(
        input === "empty" ? `data:text/plain;base64,command-${input}` : null,
      );
      if (newer) {
        expect(getChatAttachmentDataUrl(newer)).not.toBeNull();
      }
      page.view.presented = true;
      page.handoff.claim();
      expect(page.current.chatMessage).toBe(
        input === "empty" ? "/steer submitted" : input === "text" ? "Newer dock draft" : "",
      );
      expect(page.current.chatAttachments).toEqual(
        input === "empty" ? [submitted] : newer ? [newer] : [],
      );
    },
  );

  it.each([
    ["rejected", 1],
    ["rejected", 2],
    ["accepted", 1],
    ["accepted", 2],
  ] as const)(
    "settles a %s command after %i Home remounts through a live dock",
    (result, rounds) => {
      const context = {} as ApplicationContext;
      const owner = { recoveryScope: "profile-a" } as GatewayBrowserClient;
      const page = presentation(context, owner, "page");
      const submitted = storedAttachment(`remounted-${result}-${rounds}`, "text/plain");
      const scope = resolveUiConversationIdentity(page.current, page.current.sessionKey);
      storeChatComposerMemoryFallback(page.current, scope, {
        message: "/steer submitted",
        attachments: [submitted],
      });
      const recovery = captureChatCommandComposerRecovery(page.current, scope, {
        draft: "/steer submitted",
        attachments: [submitted],
      });
      page.view.presented = false;
      const dock = presentation(context, owner, "dock");
      let currentPage = page;
      for (let index = 0; index < rounds; index++) {
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

      expect(currentPage.current.chatMessage).toBe(
        result === "rejected" ? "/steer submitted" : "Keep this file",
      );
      expect(currentPage.current.chatAttachments).toEqual([submitted]);
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
    const recovery = captureChatCommandComposerRecovery(
      page.current,
      resolveUiConversationIdentity(page.current, page.current.sessionKey),
      { draft: "/steer submitted", attachments: [] },
    );

    expect(recovery.owner).toBeUndefined();
    settleChatCommandComposer(page.current, recovery, false, []);
    expect(page.current.chatMessage).toBe("/steer submitted");
  });

  it("does not restore into an abandoned source when a captured owner retires", () => {
    const page = presentation(
      {} as ApplicationContext,
      { recoveryScope: "profile-a" } as GatewayBrowserClient,
      "page",
    );
    const recovery = captureChatCommandComposerRecovery(
      page.current,
      resolveUiConversationIdentity(page.current, page.current.sessionKey),
      { draft: "/steer submitted", attachments: [] },
    );
    page.handoff.dispose();

    expect(recovery.owner).toBeDefined();
    settleChatCommandComposer(page.current, recovery, false, []);
    expect(page.current.chatMessage).toBe("");
    expect(page.current.chatComposerFallbackByScope).toEqual({});
  });

  it("releases only unreferenced command payloads after every presentation unmounts", () => {
    const context = { chatAttachmentHandoff: createChatAttachmentHandoff() } as ApplicationContext;
    const owner = { recoveryScope: "profile-a" } as GatewayBrowserClient;
    const page = presentation(context, owner, "page");
    const staged = storedAttachment("staged-command", "text/plain");
    const fallback = storedAttachment("staged-fallback", "text/plain");
    const unreferenced = storedAttachment("completed-command", "text/plain");
    const scope = resolveUiConversationIdentity(page.current, page.current.sessionKey);
    const recovery = captureChatCommandComposerRecovery(page.current, scope, {
      draft: "/steer submitted",
      attachments: [staged, fallback, unreferenced],
    });
    page.view.presented = false;
    const dock = presentation(context, owner, "dock");
    dock.handoff.claim();
    dock.edit("Current dock draft", [staged]);
    storeChatComposerMemoryFallback(dock.current, scope, {
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

    expect(getChatAttachmentDataUrl(staged)).not.toBeNull();
    expect(getChatAttachmentDataUrl(fallback)).not.toBeNull();
    expect(getChatAttachmentDataUrl(unreferenced)).toBeNull();
    context.chatAttachmentHandoff.clearPane("dock");
    expect(getChatAttachmentDataUrl(staged)).toBeNull();
    expect(getChatAttachmentDataUrl(fallback)).toBeNull();
    context.chatAttachmentHandoff.dispose();
  });

  it("clears a successful command's transferred fallback without releasing a retained file", () => {
    const context = {} as ApplicationContext;
    const owner = { recoveryScope: "profile-a" } as GatewayBrowserClient;
    const page = presentation(context, owner, "page");
    const submitted = storedAttachment("successful-command", "text/plain");
    const scope = resolveUiConversationIdentity(page.current, page.current.sessionKey);
    storeChatComposerMemoryFallback(page.current, scope, {
      message: "/approve request allow-once",
      attachments: [submitted],
    });
    const recovery = captureChatCommandComposerRecovery(page.current, scope, {
      draft: "/approve request allow-once",
      attachments: [submitted],
    });
    page.view.presented = false;
    const dock = presentation(context, owner, "dock");
    dock.handoff.claim();
    dock.edit("Keep this file", [submitted]);
    page.handoff.dispose();

    settleChatCommandComposer(page.current, recovery, true, [submitted]);

    expect(dock.current.chatComposerFallbackByScope).toEqual({});
    expect(dock.current.chatMessage).toBe("Keep this file");
    expect(getChatAttachmentDataUrl(submitted)).not.toBeNull();
  });

  it.each([
    ["current", "rejected"],
    ["replacement", "rejected"],
    ["replacement", "accepted"],
    ["reconnect", "rejected"],
    ["reconnect", "accepted"],
  ] as const)(
    "settles after source disposal only for the original connection (%s, %s command)",
    (connection, result) => {
      const context = {} as ApplicationContext;
      const owner = { recoveryScope: "profile-a", connectionGeneration: 1 } as GatewayBrowserClient;
      const page = presentation(context, owner, "page");
      const submitted = storedAttachment(`disposed-command-${connection}`, "text/plain");
      const scope = resolveUiConversationIdentity(page.current, page.current.sessionKey);
      storeChatComposerMemoryFallback(page.current, scope, {
        message: "/steer submitted",
        attachments: [submitted],
      });
      const recovery = captureChatCommandComposerRecovery(page.current, scope, {
        draft: "/steer submitted",
        attachments: [submitted],
      });
      page.view.presented = false;
      const dock = presentation(context, owner, "dock");
      dock.handoff.claim();
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
      expect(dock.current.chatMessage).toBe(connection === "current" ? "/steer submitted" : "");
      expect(dock.current.chatAttachments).toEqual(connection === "current" ? [submitted] : []);
      if (connection !== "current") {
        expect(
          dock.current.chatComposerFallbackByScope[storedChatOutboxScopeKey(scope)],
        ).toMatchObject({
          message: "/steer submitted",
          attachments: [submitted],
        });
      }
      expect(getChatAttachmentDataUrl(submitted)).not.toBeNull();
    },
  );

  it.each([
    ["agent:main:main", false],
    ["global", false],
    ["agent:main:main", true],
    ["global", true],
  ] as const)(
    "moves edited draft and file back to the already-retained Home (%s, client rotation=%s)",
    (sessionKey, rotateClient) => {
      const context = {} as ApplicationContext;
      const owner = { recoveryScope: "profile-a" } as GatewayBrowserClient;
      const page = presentation(context, owner, "page", sessionKey);
      page.edit("Home page draft");
      page.view.presented = false;
      const dock = presentation(context, owner, "dock", sessionKey);
      dock.handoff.claim();
      expect(dock.current.chatMessage).toBe("Home page draft");
      const file = storedAttachment(`roundtrip-${sessionKey}`, "text/plain");
      dock.edit("Edited in the dock", [file]);
      const queued = enqueueChatMessage(dock.current, "queued original")!;
      expect(beginQueuedMessageEdit(dock.current, queued.id)).toBe("started");
      updateQueuedMessageEdit(dock.current, "unfinished queue correction");
      if (rotateClient) {
        const replacement = {
          recoveryScope: "profile-a",
          recoveryScopeReady: true,
        } as GatewayBrowserClient;
        for (const pane of [page, dock]) {
          pane.view.owner = replacement;
          pane.current.client = replacement;
        }
      }

      // A retained source may still receive invalidations, but relinquished
      // persistence must never overwrite the current presentation's newer edit.
      page.current.chatMessage = "stale retained draft";
      page.current.requestUpdate();
      expect(loadChatComposerSnapshot(dock.current, sessionKey)?.draft).toBe("Edited in the dock");
      page.view.presented = true;
      page.handoff.claim();
      dock.handoff.dispose();

      expect(page.current.chatMessage).toBe("Edited in the dock");
      expect(page.current.chatAttachments).toEqual([file]);
      expect(getChatAttachmentDataUrl(file)).not.toBeNull();
      expect(dock.current.chatAttachments).toEqual([]);
      expect(loadChatComposerSnapshot(page.current, sessionKey)?.draft).toBe("Edited in the dock");
      expect(activeQueuedMessageEdit(page.current)?.draftText).toBe("unfinished queue correction");
      expect(dock.current.chatQueuedEdit).toBeNull();
      expect(isQueuedMessageBeingEdited(dock.current, queued.id)).toBe(true);
      expect(cancelQueuedMessageEdit(page.current)).toBe(true);
      expect(isQueuedMessageBeingEdited(dock.current, queued.id)).toBe(false);
    },
  );

  it.each([
    "region",
    "agent",
    "session",
    "client",
    "profile",
    "gateway",
    "unverified-rotation",
  ] as const)("does not transfer across a different %s owner", (difference) => {
    const context = {} as ApplicationContext;
    const owner = { recoveryScope: "profile-a" } as GatewayBrowserClient;
    const page = presentation(context, owner, "page");
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
      difference === "client" || difference === "unverified-rotation"
        ? ({ recoveryScope: "profile-a" } as GatewayBrowserClient)
        : owner;
    if (difference === "unverified-rotation") {
      page.view.owner = nextOwner;
      page.current.client = nextOwner;
    }
    const dock = presentation(
      context,
      nextOwner,
      difference === "region" ? "page" : "dock",
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
  });
});

describe("staged chat attachment pane handoff", () => {
  it("discards a mounted package before clearing a closed pane handoff", () => {
    const calls: string[] = [];
    const root = {
      querySelectorAll: () => [
        { paneId: "p1", discardStagedAttachments: () => calls.push("discard-one") },
        { paneId: "p1", discardStagedAttachments: () => calls.push("discard-two") },
        { paneId: "p2", discardStagedAttachments: () => calls.push("wrong-pane") },
      ],
    } as unknown as ParentNode;
    const context = {
      chatAttachmentHandoff: { clearPane: () => calls.push("clear") },
    } as unknown as ApplicationContext;
    const layout = {
      columns: [
        {
          id: "c1",
          panes: [
            { id: "p1", sessionKey: "one" },
            { id: "p2", sessionKey: "two" },
          ],
          paneWeights: [1, 1],
        },
      ],
      columnWeights: [1],
      activePaneId: "p1",
    } satisfies ChatSplitLayout;

    expect(closeStagedPane(context, root, layout, "p1")?.id).toBe("p2");
    expect(calls).toEqual(["discard-one", "discard-two", "clear"]);
  });

  it("does not restage a closed pane when its id is reused after disconnect", () => {
    const owner = {} as GatewayBrowserClient;
    const { pane, state: current } = createTestChatPane({
      client: owner,
      sessions: {} as SessionCapability,
    });
    pane.paneId = "p2";
    const fallback = storedAttachment("closed-fallback");
    current.chatComposerFallbackByScope = {
      fallback: {
        attachments: [fallback],
        message: "closed pane draft",
        sequence: 1,
        storageFailed: false,
      },
    };
    const root = { querySelectorAll: () => [pane] } as unknown as ParentNode;
    const layout = {
      columns: [
        {
          id: "c1",
          panes: [
            { id: "p1", sessionKey: "one" },
            { id: "p2", sessionKey: current.sessionKey },
          ],
          paneWeights: [1, 1],
        },
      ],
      columnWeights: [1],
      activePaneId: "p2",
    } satisfies ChatSplitLayout;
    const scopeKey = storedChatOutboxScopeKey(
      resolveUiConversationIdentity(current, current.sessionKey),
    );

    closeStagedPane(pane.context, root, layout, pane.paneId);
    const lateAttachment = storedAttachment("late-close-completion");
    current.chatAttachments.push(lateAttachment);
    pane.disconnectedCallback();

    expect(getChatAttachmentDataUrl(fallback)).toBeNull();
    expect(getChatAttachmentDataUrl(lateAttachment)).toBeNull();
    expect(
      pane.context.chatAttachmentHandoff.consume({
        owner,
        paneId: "p2",
        scopeKey,
      }),
    ).toBeNull();
  });

  it("hands off new work after a retained closed pane is reactivated", () => {
    const owner = {} as GatewayBrowserClient;
    const { pane, state: current } = createTestChatPane({
      client: owner,
      sessions: {} as SessionCapability,
    });
    pane.paneId = "p2";
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
    const scopeKey = storedChatOutboxScopeKey(
      resolveUiConversationIdentity(current, current.sessionKey),
    );

    pane.disconnectedCallback();

    expect(
      pane.context.chatAttachmentHandoff.consume({
        owner,
        paneId: pane.paneId,
        scopeKey,
      })?.attachments,
    ).toEqual([reopened]);
    releaseChatAttachmentPayload(reopened.id);
  });

  it("deduplicates current and fallback payload release", () => {
    const shared = storedAttachment("shared");
    const fallback = storedAttachment("fallback", "application/pdf");
    const current = state([shared]);
    current.chatComposerFallbackByScope = {
      fallback: {
        attachments: [shared, fallback],
        message: "",
        sequence: 1,
        storageFailed: false,
      },
    };

    discardStateStagedAttachments(current);

    expect(getChatAttachmentDataUrl(shared)).toBeNull();
    expect(getChatAttachmentDataUrl(fallback)).toBeNull();
    expect(current.chatAttachments).toEqual([]);
    expect(current.chatComposerFallbackByScope.fallback?.attachments).toEqual([]);
  });

  it("keeps plain staged attachments across a gateway client rotation", () => {
    const previousOwner = {} as GatewayBrowserClient;
    const nextOwner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff();
    const context = { chatAttachmentHandoff: handoff } as unknown as ApplicationContext;
    const plainImage = storedAttachment("rotation-image");
    const plainFile = storedAttachment("rotation-file", "application/pdf");
    const annotated: ChatAttachment = {
      ...storedAttachment("rotation-annotation"),
      browserAnnotation: { pageUrl: "https://example.test" } as never,
    };
    const current = state([plainImage, plainFile, annotated]);

    const returned = replacePaneStagedAttachmentGatewayOwner(
      context,
      "p1",
      current,
      previousOwner,
      nextOwner,
    );

    expect(returned).toBe(nextOwner);
    // Plain payloads are client-local; rotation must not silently discard them.
    expect(current.chatAttachments).toEqual([plainImage, plainFile]);
    expect(getChatAttachmentDataUrl(plainImage)).not.toBeNull();
    expect(getChatAttachmentDataUrl(plainFile)).not.toBeNull();
    // Annotation Undo context dies with the old client; its payload is released.
    expect(getChatAttachmentDataUrl(annotated)).toBeNull();
    discardStateStagedAttachments(current);
  });

  it("restores a mixed package only to the exact mounted owner", () => {
    const owner = {} as GatewayBrowserClient;
    const otherOwner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff();
    const context = { chatAttachmentHandoff: handoff } as unknown as ApplicationContext;
    const image = storedAttachment("image");
    const file = storedAttachment("file", "application/pdf");
    const pastedText = storedAttachment("pasted-text", "text/plain");
    const mixed = [image, file, pastedText];

    preparePaneStagedAttachments(context, "p1", state(mixed), owner, 0);
    const mismatched = state([]);
    restorePaneStagedAttachments(context, "p1", mismatched, otherOwner);
    expect(mismatched.chatAttachments).toEqual([]);
    expect(mixed.every((attachment) => getChatAttachmentDataUrl(attachment) === null)).toBe(true);

    const second = [storedAttachment("second-image"), storedAttachment("second-file")];
    preparePaneStagedAttachments(context, "p2", state(second), owner, 0);
    const remount = state([]);
    restorePaneStagedAttachments(context, "p2", remount, owner);
    expect(remount.chatAttachments).toEqual(second);
    expect(remount.chatAttachments.every((attachment, index) => attachment === second[index])).toBe(
      true,
    );
    discardStateStagedAttachments(remount);
  });

  it("rejects every part of an evicted composer after a newer split edit", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const owner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff();
    const context = { chatAttachmentHandoff: handoff } as unknown as ApplicationContext;
    const older = state([]);
    older.chatMessage = "";
    older.chatQueue = [];
    const olderPersistence = new ChatComposerPersistence(() => older);
    const newer = state([]);
    newer.chatMessage = "";
    newer.chatQueue = [];
    const newerPersistence = new ChatComposerPersistence(() => newer);
    const obsolete = storedAttachment("evicted-old-image");
    try {
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
      const remount = state([]);
      remount.chatMessage = "";
      remount.chatQueue = [];
      const restoredPersistence = new ChatComposerPersistence(() => remount);
      restoredPersistence.restore();
      restorePaneStagedAttachments(context, "p1", remount, owner);
      expect(remount.chatMessage).toBe("@New draft");
      expect(remount.chatMentions).toEqual(newer.chatMentions);
      expect(remount.chatGoalDraftMode).toBeNull();
      expect(remount.chatAttachments).toEqual([]);
      expect(getChatAttachmentDataUrl(obsolete)).toBeNull();
    } finally {
      olderPersistence.stop();
      newerPersistence.stop();
      handoff.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("keeps an unsaved composer and its recovery warning across eviction", () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const owner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff();
    const context = { chatAttachmentHandoff: handoff } as unknown as ApplicationContext;
    const source = state([]);
    source.chatMessage = "";
    source.chatQueue = [];
    const persistence = new ChatComposerPersistence(() => source);
    const image = storedAttachment("unsaved-image");
    try {
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
      storeChatComposerMemoryFallback(
        source,
        resolveUiConversationIdentity(source, source.sessionKey),
        {
          message: source.chatMessage,
          mentions: source.chatMentions,
          goalMode: source.chatGoalDraftMode,
          attachments: source.chatAttachments,
          draftRetry: result,
        },
      );
      preparePaneStagedAttachments(context, "p1", source, owner, persistence.draftRevision);
      const remount = state([]);
      restorePaneStagedAttachments(context, "p1", remount, owner);
      expect(remount.chatMessage).toBe(source.chatMessage);
      expect(remount.chatMentions).toEqual(source.chatMentions);
      expect(remount.chatGoalDraftMode).toEqual(source.chatGoalDraftMode);
      expect(remount.chatAttachments).toEqual([image]);
      expect(remount.chatError).toBe(CHAT_COMPOSER_DRAFT_STORAGE_ERROR);
      expect(remount.chatComposerFallbackByScope).toEqual(source.chatComposerFallbackByScope);
      expect(getChatAttachmentDataUrl(image)).not.toBeNull();
      discardStateStagedAttachments(remount);
    } finally {
      persistence.stop();
      handoff.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("releases a restored fallback displaced by mounted state", () => {
    const owner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff();
    const context = { chatAttachmentHandoff: handoff } as unknown as ApplicationContext;
    const displaced = storedAttachment("displaced");
    const mounted = storedAttachment("mounted");
    const remount = state([]);
    handoff.prepare({
      owner,
      paneId: "p1",
      scopeKey: storedChatOutboxScopeKey(
        resolveUiConversationIdentity(remount, remount.sessionKey),
      ),
      attachments: [],
      fallbacks: {
        collision: {
          attachments: [displaced],
          message: "old",
          sequence: 1,
          storageFailed: false,
        },
      },
    });
    remount.chatComposerFallbackByScope = {
      collision: {
        attachments: [mounted],
        message: "new",
        sequence: 2,
        storageFailed: false,
      },
    };

    restorePaneStagedAttachments(context, "p1", remount, owner);

    expect(remount.chatComposerFallbackByScope.collision?.attachments).toEqual([mounted]);
    expect(getChatAttachmentDataUrl(displaced)).toBeNull();
    expect(getChatAttachmentDataUrl(mounted)).not.toBeNull();
    discardStateStagedAttachments(remount);
  });
});
