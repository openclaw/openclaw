/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ChatAttachment } from "../lib/chat/chat-types.ts";
import { storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../pages/chat/attachment-payload-store.ts";
import { reviewPrivateComposerDraft } from "../pages/chat/components/private-composer-recovery-dialog.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import {
  registerControlUiReloadGuard,
  canReloadControlUiDocument,
} from "./document-reload-guard.ts";

const reviewUi = vi.hoisted(() => ({
  review: vi.fn<() => Promise<boolean>>(),
  toast: vi.fn<(options: { onAction?: () => void }) => boolean>(() => true),
}));
vi.mock("../pages/chat/components/private-composer-recovery-dialog.ts", () => ({
  reviewPrivateComposerDraft: reviewUi.review,
}));
vi.mock("../lib/toast.ts", () => ({ showToast: reviewUi.toast }));

const registeredIds = new Set<string>();

function storedAttachment(id: string, mimeType: string, annotated: boolean): ChatAttachment {
  const attachment: ChatAttachment = {
    id,
    mimeType,
    ...(annotated
      ? {
          browserAnnotation: {
            modelContext: `Context ${id}`,
            title: `Page ${id}`,
            displayUrl: "example.com",
            markedRegionCount: 1,
            inspectedElement: false,
          },
        }
      : {}),
  };
  registeredIds.add(id);
  return registerChatAttachmentPayload({
    attachment,
    dataUrl: `data:${mimeType};base64,${id}`,
    file: new File([id], id, { type: mimeType }),
  });
}

afterEach(() => {
  for (const id of registeredIds) {
    releaseChatAttachmentPayload(id);
  }
  registeredIds.clear();
});

describe("chat attachment route handoff", () => {
  it.each(["same owner", "new credentials", "new authenticated owner"] as const)(
    "retains private handoff reload protection only for %s",
    (replacement) => {
      const owner = { recoveryScope: "owner-a", recoveryScopeReady: true } as GatewayBrowserClient;
      const fixture = createApplicationGateway();
      const { gateway } = fixture;
      fixture.publish({
        ...gateway.snapshot,
        phase: "connected",
        client: owner,
        selfUser: { id: "owner-a" },
      });
      const handoff = createChatAttachmentHandoff(gateway);
      const attachment = storedAttachment("private-owner", "text/plain", false);
      try {
        handoff.prepare({
          reviewPrivateDraft: reviewPrivateComposerDraft,
          owner,
          paneId: "p1",
          scopeKey: "metadata-private",
          incognito: true,
          message: "private draft",
          attachments: [attachment],
          fallbacks: {},
        });
        handoff.prepare({
          reviewPrivateDraft: reviewPrivateComposerDraft,
          owner,
          paneId: "ordinary-sibling",
          scopeKey: "ordinary",
          attachments: [attachment],
          fallbacks: {},
        });
        expect(canReloadControlUiDocument()).toBe(false);
        if (replacement === "new credentials") {
          Object.assign(gateway, { connectionRevision: gateway.connectionRevision + 1 });
        }
        const nextOwner = {
          recoveryScope: replacement === "new authenticated owner" ? "owner-b" : "owner-a",
          recoveryScopeReady: true,
        } as GatewayBrowserClient;
        fixture.publish({
          ...gateway.snapshot,
          client: nextOwner,
          selfUser: { id: replacement === "new authenticated owner" ? "owner-b" : "owner-a" },
        });
        expect(canReloadControlUiDocument()).toBe(replacement !== "same owner");
        expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
        expect(handoff.retainedAttachmentIds([attachment])).toEqual(new Set([attachment.id]));
        if (replacement === "same owner") {
          expect(
            handoff.consume({ owner, paneId: "ordinary-sibling", scopeKey: "ordinary" })
              ?.attachments,
          ).toEqual([attachment]);
        }
      } finally {
        handoff.dispose();
      }
      expect(canReloadControlUiDocument()).toBe(true);
    },
  );

  it("discards only the reviewed private fallback and preserves other retained input", async () => {
    const fixture = createApplicationGateway();
    const { gateway } = fixture;
    const owner = { recoveryScope: "owner-a", recoveryScopeReady: true } as GatewayBrowserClient;
    fixture.publish({ ...gateway.snapshot, phase: "connected", client: owner });
    const handoff = createChatAttachmentHandoff(gateway);
    const shared = storedAttachment("shared-private-fallback", "text/plain", false);
    const scopeKey = storedChatOutboxScopeKey({ sessionKey: "agent:main:ordinary" });
    const privateScope = storedChatOutboxScopeKey({
      sessionKey: "agent:main:metadata-private-fallback",
    });
    const pending = createDeferred<boolean>();
    reviewUi.review.mockReturnValue(pending.promise);
    const releaseOther = registerControlUiReloadGuard(
      () => false,
      () => undefined,
    );
    try {
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner,
        paneId: "p1",
        scopeKey,
        message: "ordinary input",
        attachments: [shared],
        fallbacks: {
          [privateScope]: {
            incognito: true,
            message: "private fallback",
            attachments: [shared],
            storageFailed: false,
            sequence: 1,
          },
          another: {
            message: "unreviewed sibling",
            attachments: [],
            storageFailed: false,
            sequence: 2,
          },
        },
      });
      expect(canReloadControlUiDocument(true)).toBe(false);
      reviewUi.toast.mock.lastCall?.[0].onAction?.();
      expect(reviewUi.review).toHaveBeenCalledOnce();
      pending.resolve(true);
      await pending.promise;
      const retained = handoff.consume({ owner, paneId: "p1", scopeKey });
      expect(retained?.message).toBe("ordinary input");
      expect(retained?.fallbacks[privateScope]).toBeUndefined();
      expect(retained?.fallbacks.another?.message).toBe("unreviewed sibling");
      expect(getChatAttachmentDataUrl(shared)).not.toBeNull();
      expect(canReloadControlUiDocument()).toBe(false);
    } finally {
      releaseOther();
      handoff.dispose();
    }
    expect(canReloadControlUiDocument()).toBe(true);
  });

  it("reports only supplied payload IDs still held by staged packages or fallbacks", () => {
    const handoff = createChatAttachmentHandoff(createApplicationGateway().gateway);
    const owner = {} as GatewayBrowserClient;
    const staged = storedAttachment("query-staged", "text/plain", false);
    const fallback = storedAttachment("query-fallback", "text/plain", false);
    const unreferenced = storedAttachment("query-unreferenced", "text/plain", false);
    try {
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner,
        paneId: "dock",
        scopeKey: "home",
        attachments: [staged],
        fallbacks: {
          home: { message: "Fallback", attachments: [fallback], storageFailed: false, sequence: 1 },
        },
      });
      expect(handoff.retainedAttachmentIds([staged, fallback, unreferenced])).toEqual(
        new Set([staged.id, fallback.id]),
      );
      expect(handoff.retainedAttachmentIds([fallback])).toEqual(new Set([fallback.id]));
      expect(handoff.consume({ owner, paneId: "dock", scopeKey: "home" })?.attachments).toEqual([
        staged,
      ]);
      expect(handoff.retainedAttachmentIds([staged, fallback])).toEqual(new Set());
    } finally {
      handoff.dispose();
    }
  });

  it("retires deleted-session packages across panes without erasing newer packages or siblings", () => {
    vi.useFakeTimers();
    const { gateway } = createApplicationGateway();
    const handoff = createChatAttachmentHandoff(gateway);
    const principal = { recoveryScope: "other", recoveryScopeReady: true };
    const owner = principal as GatewayBrowserClient;
    const otherOwner = { ...principal, recoveryScope: "original" } as GatewayBrowserClient;
    gateway.snapshot.client = owner;
    const scopeKey = "agent:main:deleted";
    const old = storedAttachment("old-deleted", "image/png", false);
    const unshared = storedAttachment("unshared-deleted", "image/png", false);
    const fresh = storedAttachment("newer-deleted", "image/png", false);
    const sibling = storedAttachment("kept-sibling", "image/png", false);
    const otherGateway = storedAttachment("kept-gateway", "image/png", false);
    const otherPrincipal = storedAttachment("kept-principal", "image/png", false);
    try {
      vi.setSystemTime(100);
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner,
        paneId: "other-principal",
        scopeKey,
        attachments: [otherPrincipal],
        fallbacks: {},
      });
      principal.recoveryScope = "original";
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner,
        paneId: "p1",
        scopeKey,
        attachments: [old, unshared],
        fallbacks: {},
      });
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner,
        paneId: "p2",
        scopeKey: "sibling",
        attachments: [sibling],
        fallbacks: {},
      });
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner: otherOwner,
        paneId: "other-gateway",
        scopeKey,
        attachments: [otherGateway, old],
        fallbacks: {},
      });
      vi.setSystemTime(300);
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner,
        paneId: "p3",
        scopeKey,
        attachments: [fresh],
        fallbacks: {},
      });
      handoff.retireScope(scopeKey, 200);
      expect(handoff.consume({ owner, paneId: "p1", scopeKey })).toBeNull();
      expect(getChatAttachmentDataUrl(unshared)).toBeNull();
      expect(getChatAttachmentDataUrl(old)).not.toBeNull();
      expect(getChatAttachmentDataUrl(otherPrincipal)).not.toBeNull();
      expect(handoff.retainedAttachmentIds([otherPrincipal])).toEqual(new Set([otherPrincipal.id]));
      expect(handoff.consume({ owner, paneId: "p3", scopeKey })?.attachments).toEqual([fresh]);
      expect(handoff.consume({ owner, paneId: "p2", scopeKey: "sibling" })?.attachments).toEqual([
        sibling,
      ]);
      gateway.snapshot.client = otherOwner;
      expect(
        handoff.consume({ owner: otherOwner, paneId: "other-gateway", scopeKey })?.attachments,
      ).toEqual([otherGateway, old]);
      // Deletion preserves the inactive owner's package, but returning to that
      // account cannot revive a presentation retired by an account switch.
      gateway.snapshot.client = owner;
      principal.recoveryScope = "other";
      expect(handoff.consume({ owner, paneId: "other-principal", scopeKey })).toBeNull();
      expect(getChatAttachmentDataUrl(otherPrincipal)).toBeNull();
    } finally {
      handoff.dispose();
      vi.useRealTimers();
    }
  });

  it("transfers every exact staged attachment object once", () => {
    const owner = {} as GatewayBrowserClient;
    const annotation = storedAttachment("annotation", "image/png", true);
    const ordinary = [
      storedAttachment("image", "image/png", false),
      storedAttachment("file", "application/pdf", false),
      storedAttachment("pasted-text", "text/plain", false),
    ];
    const staged = [ordinary[0]!, annotation, ordinary[1]!, ordinary[2]!];
    const handoff = createChatAttachmentHandoff(createApplicationGateway().gateway);
    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: staged,
      fallbacks: {},
    });

    const consumed = handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" });
    expect(consumed?.attachments).toEqual(staged);
    expect(consumed?.attachments).not.toBe(staged);
    expect(consumed?.attachments.every((attachment, index) => attachment === staged[index])).toBe(
      true,
    );
    expect(handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" })).toBeNull();
    for (const attachment of ordinary) {
      expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
    }
  });

  it.each(["gateway", "principal"] as const)(
    "isolates retained session scopes and releases a %s mismatch",
    (change) => {
      const { gateway } = createApplicationGateway();
      const handoff = createChatAttachmentHandoff(gateway);
      const principal = { recoveryScope: "original", recoveryScopeReady: true };
      const expectedOwner = principal as GatewayBrowserClient;
      gateway.snapshot.client = expectedOwner;
      const first = storedAttachment("first-scope", "image/png", true);
      const second = storedAttachment("second-scope", "image/png", true);
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner: expectedOwner,
        paneId: "p1",
        scopeKey: "agent:main:one",
        attachments: [first],
        fallbacks: {},
      });
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner: expectedOwner,
        paneId: "p1",
        scopeKey: "agent:main:two",
        attachments: [second],
        fallbacks: {},
      });

      if (change === "principal") {
        principal.recoveryScope = "other";
      }
      expect(
        handoff.consume({
          owner: change === "gateway" ? ({} as GatewayBrowserClient) : expectedOwner,
          paneId: "p1",
          scopeKey: "agent:main:two",
        }),
      ).toBeNull();
      expect(getChatAttachmentDataUrl(second)).toBeNull();
      expect(getChatAttachmentDataUrl(first)).not.toBeNull();
      principal.recoveryScope = "original";
      const retained = handoff.consume({
        owner: expectedOwner,
        paneId: "p1",
        scopeKey: "agent:main:one",
      });
      if (change === "principal") {
        // Restoring the same credential value does not restore its retired
        // presentation identity or authorize an old handoff.
        expect(retained).toBeNull();
        expect(getChatAttachmentDataUrl(first)).toBeNull();
        const fresh = storedAttachment("fresh-principal", "image/png", true);
        handoff.prepare({
          reviewPrivateDraft: reviewPrivateComposerDraft,
          owner: expectedOwner,
          paneId: "p1",
          scopeKey: "agent:main:one",
          attachments: [fresh],
          fallbacks: {},
        });
        expect(
          handoff.consume({ owner: expectedOwner, paneId: "p1", scopeKey: "agent:main:one" }),
        ).toEqual({ attachments: [fresh], fallbacks: {} });
      } else {
        expect(retained).toEqual({ attachments: [first], fallbacks: {} });
      }
    },
  );

  it("does not let an empty retained session teardown erase another scope", () => {
    const handoff = createChatAttachmentHandoff(createApplicationGateway().gateway);
    const owner = {} as GatewayBrowserClient;
    const annotation = storedAttachment("overlapping-scope", "image/png", true);
    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: [annotation],
      fallbacks: {},
    });
    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner,
      paneId: "p1",
      scopeKey: "agent:main:two",
      attachments: [],
      fallbacks: {},
    });

    expect(
      handoff.consume({ owner, paneId: "p1", scopeKey: "agent:main:one" })?.attachments,
    ).toEqual([annotation]);
  });

  it("keeps payloads reused by a replacement prepare", () => {
    const owner = {} as GatewayBrowserClient;
    const retained = storedAttachment("replacement-retained", "image/png", false);
    const removed = storedAttachment("replacement-removed", "image/png", false);
    const handoff = createChatAttachmentHandoff(createApplicationGateway().gateway);
    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner,
      paneId: "p1",
      scopeKey: "one",
      attachments: [retained, removed],
      fallbacks: {},
    });
    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner,
      paneId: "p1",
      scopeKey: "one",
      attachments: [retained],
      fallbacks: {},
    });

    expect(getChatAttachmentDataUrl(retained)).not.toBeNull();
    expect(getChatAttachmentDataUrl(removed)).toBeNull();
    expect(handoff.consume({ owner, paneId: "p1", scopeKey: "one" })?.attachments).toEqual([
      retained,
    ]);
  });

  it("bounds abandoned entries and releases pane-clear and application disposal", () => {
    const owner = {} as GatewayBrowserClient;
    const handoff = createChatAttachmentHandoff(createApplicationGateway().gateway);
    const oversized = Array.from({ length: 33 }, (_, index) =>
      storedAttachment(`oversized-${index}`, "image/png", false),
    );
    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner,
      paneId: "oversized",
      scopeKey: "oversized",
      attachments: oversized,
      fallbacks: {},
    });
    expect(
      handoff.consume({ owner, paneId: "oversized", scopeKey: "oversized" })?.attachments,
    ).toEqual(oversized);
    expect(getChatAttachmentDataUrl(oversized[32]!)).not.toBeNull();

    const annotations = Array.from({ length: 33 }, (_, index) =>
      storedAttachment(`bounded-${index}`, "image/png", true),
    );
    annotations.forEach((annotation, index) =>
      handoff.prepare({
        reviewPrivateDraft: reviewPrivateComposerDraft,
        owner,
        paneId: `p${index}`,
        scopeKey: `scope-${index}`,
        attachments: [annotation],
        fallbacks: {},
      }),
    );

    expect(getChatAttachmentDataUrl(annotations[0]!)).toBeNull();
    expect(getChatAttachmentDataUrl(annotations[1]!)).not.toBeNull();
    handoff.clearPane("p1");
    expect(getChatAttachmentDataUrl(annotations[1]!)).toBeNull();
    handoff.dispose();
    expect(getChatAttachmentDataUrl(annotations[32]!)).toBeNull();
  });

  it("releases a late prepare after application disposal instead of restaging it", () => {
    const handoff = createChatAttachmentHandoff(createApplicationGateway().gateway);
    const annotation = storedAttachment("late", "image/png", true);
    handoff.dispose();

    handoff.prepare({
      reviewPrivateDraft: reviewPrivateComposerDraft,
      owner: {} as GatewayBrowserClient,
      paneId: "p1",
      scopeKey: "agent:main:one",
      attachments: [annotation],
      fallbacks: {},
    });

    expect(getChatAttachmentDataUrl(annotation)).toBeNull();
    expect(
      handoff.consume({
        owner: {} as GatewayBrowserClient,
        paneId: "p1",
        scopeKey: "agent:main:one",
      }),
    ).toBeNull();
  });
});
