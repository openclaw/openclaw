/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ChatAttachment } from "../lib/chat/chat-types.ts";
import { storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../pages/chat/attachment-payload-store.ts";
import { reviewPrivateComposerDraft } from "../pages/chat/components/private-composer-recovery-dialog.tsx";
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
vi.mock(
  "../pages/chat/components/private-composer-recovery-dialog.tsx",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../pages/chat/components/private-composer-recovery-dialog.tsx")
    >()),
    reviewPrivateComposerDraft: reviewUi.review,
  }),
);
vi.mock("../lib/toast.ts", () => ({ showToast: reviewUi.toast }));

const registeredIds = new Set<string>();
const cleanups: Array<() => void> = [];
function handoffFor(gateway = createApplicationGateway().gateway) {
  const handoff = createChatAttachmentHandoff(gateway);
  cleanups.push(() => handoff.dispose());
  return handoff;
}

function storedAttachment(id: string, mimeType = "image/png", annotated = false): ChatAttachment {
  const attachment: ChatAttachment = { id, mimeType };
  if (annotated) {
    attachment.browserAnnotation = {
      modelContext: `Context ${id}`,
      title: `Page ${id}`,
      displayUrl: "example.com",
      markedRegionCount: 1,
      inspectedElement: false,
    };
  }
  registeredIds.add(id);
  return registerChatAttachmentPayload({
    attachment,
    dataUrl: `data:${mimeType};base64,${id}`,
    file: new File([id], id, { type: mimeType }),
  });
}

type Handoff = ReturnType<typeof createChatAttachmentHandoff>;
type Prepare = Parameters<Handoff["prepare"]>[0];

function prepare(
  handoff: Handoff,
  owner: Prepare["owner"],
  paneId: string,
  scopeKey: string,
  attachments: ChatAttachment[],
  options: Partial<Omit<Prepare, "owner" | "paneId" | "scopeKey" | "attachments">> = {},
) {
  handoff.prepare({
    reviewPrivateDraft: reviewPrivateComposerDraft,
    owner,
    paneId,
    scopeKey,
    attachments,
    fallbacks: {},
    ...options,
  });
}

function consume(handoff: Handoff, owner: Prepare["owner"], paneId: string, scopeKey: string) {
  return handoff.consume({ owner, paneId, scopeKey });
}
afterEach(() => {
  cleanups
    .splice(0)
    .toReversed()
    .forEach((cleanup) => cleanup());
  vi.useRealTimers();
  for (const id of registeredIds) {
    releaseChatAttachmentPayload(id);
  }
  registeredIds.clear();
});

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
    const handoff = handoffFor(gateway);
    const attachment = storedAttachment("private-owner", "text/plain", false);

    prepare(handoff, owner, "p1", "metadata-private", [attachment], {
      incognito: true,
      message: "private draft",
    });
    prepare(handoff, owner, "sibling", "ordinary", [attachment]);
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
      expect(consume(handoff, owner, "sibling", "ordinary")?.attachments).toEqual([attachment]);
    }
    handoff.dispose();
    expect(canReloadControlUiDocument()).toBe(true);
  },
);

it("discards only the reviewed private fallback and preserves other retained input", async () => {
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  const owner = { recoveryScope: "owner-a", recoveryScopeReady: true } as GatewayBrowserClient;
  fixture.publish({ ...gateway.snapshot, phase: "connected", client: owner });
  const handoff = handoffFor(gateway);
  const shared = storedAttachment("shared-private-fallback", "text/plain", false);
  const scopeKey = storedChatOutboxScopeKey({ sessionKey: "agent:main:ordinary" });
  const privateScope = storedChatOutboxScopeKey({ sessionKey: "agent:main:private" });
  const pending = createDeferred<boolean>();
  reviewUi.review.mockReturnValue(pending.promise);
  const releaseOther = registerControlUiReloadGuard(
    () => false,
    () => undefined,
  );
  cleanups.push(releaseOther);

  prepare(handoff, owner, "p1", scopeKey, [shared], {
    message: "ordinary input",
    fallbacks: {
      [privateScope]: {
        message: "private fallback",
        attachments: [shared],
        sequence: 1,
        storageFailed: false,
        incognito: true,
      },
      another: {
        message: "unreviewed sibling",
        attachments: [],
        sequence: 2,
        storageFailed: false,
      },
    },
  });
  expect(canReloadControlUiDocument(true)).toBe(false);
  reviewUi.toast.mock.lastCall?.[0].onAction?.();
  expect(reviewUi.review).toHaveBeenCalledOnce();
  pending.resolve(true);
  await pending.promise;
  const retained = consume(handoff, owner, "p1", scopeKey);
  expect(retained?.message).toBe("ordinary input");
  expect(retained?.fallbacks[privateScope]).toBeUndefined();
  expect(retained?.fallbacks.another?.message).toBe("unreviewed sibling");
  expect(getChatAttachmentDataUrl(shared)).not.toBeNull();
  expect(canReloadControlUiDocument()).toBe(false);
  releaseOther();
  handoff.dispose();
  expect(canReloadControlUiDocument()).toBe(true);
});

it("reports only supplied payload IDs still held by staged packages or fallbacks", () => {
  const handoff = handoffFor();
  const owner = {} as GatewayBrowserClient;
  const staged = storedAttachment("query-staged", "text/plain", false);
  const fallback = storedAttachment("query-fallback", "text/plain", false);
  const unreferenced = storedAttachment("query-unreferenced", "text/plain", false);

  prepare(handoff, owner, "dock", "home", [staged], {
    fallbacks: {
      home: { message: "Fallback", attachments: [fallback], sequence: 1, storageFailed: false },
    },
  });
  expect(handoff.retainedAttachmentIds([staged, fallback, unreferenced])).toEqual(
    new Set([staged.id, fallback.id]),
  );
  expect(handoff.retainedAttachmentIds([fallback])).toEqual(new Set([fallback.id]));
  expect(consume(handoff, owner, "dock", "home")?.attachments).toEqual([staged]);
  expect(handoff.retainedAttachmentIds([staged, fallback])).toEqual(new Set());
});

it("retires deleted-session packages across panes without erasing newer packages or siblings", () => {
  vi.useFakeTimers();
  const { gateway } = createApplicationGateway();
  const handoff = handoffFor(gateway);
  const principal = { recoveryScope: "other", recoveryScopeReady: true };
  const owner = principal as GatewayBrowserClient;
  const otherOwner = { ...principal, recoveryScope: "original" } as GatewayBrowserClient;
  gateway.snapshot.client = owner;
  const scopeKey = "agent:main:deleted";
  const old = storedAttachment("old-deleted");
  const unshared = storedAttachment("unshared-deleted");
  const fresh = storedAttachment("newer-deleted");
  const sibling = storedAttachment("kept-sibling");
  const otherGateway = storedAttachment("kept-gateway");
  const otherPrincipal = storedAttachment("kept-principal");

  vi.setSystemTime(100);
  prepare(handoff, owner, "other-principal", scopeKey, [otherPrincipal]);
  principal.recoveryScope = "original";
  prepare(handoff, owner, "p1", scopeKey, [old, unshared]);
  prepare(handoff, owner, "p2", "sibling", [sibling]);
  prepare(handoff, otherOwner, "other-gateway", scopeKey, [otherGateway, old]);
  vi.setSystemTime(300);
  prepare(handoff, owner, "p3", scopeKey, [fresh]);
  handoff.retireScope(scopeKey, 200);
  expect(consume(handoff, owner, "p1", scopeKey)).toBeNull();
  expect(getChatAttachmentDataUrl(unshared)).toBeNull();
  expect(getChatAttachmentDataUrl(old)).not.toBeNull();
  expect(getChatAttachmentDataUrl(otherPrincipal)).not.toBeNull();
  expect(handoff.retainedAttachmentIds([otherPrincipal])).toEqual(new Set([otherPrincipal.id]));
  expect(consume(handoff, owner, "p3", scopeKey)?.attachments).toEqual([fresh]);
  expect(consume(handoff, owner, "p2", "sibling")?.attachments).toEqual([sibling]);
  gateway.snapshot.client = otherOwner;
  expect(consume(handoff, otherOwner, "other-gateway", scopeKey)?.attachments).toEqual([
    otherGateway,
    old,
  ]);
  gateway.snapshot.client = owner;
  principal.recoveryScope = "other";
  expect(consume(handoff, owner, "other-principal", scopeKey)).toBeNull();
  expect(getChatAttachmentDataUrl(otherPrincipal)).toBeNull();
});

it.each(["gateway", "principal"] as const)(
  "isolates retained session scopes and releases a %s mismatch",
  (change) => {
    const { gateway } = createApplicationGateway();
    const handoff = handoffFor(gateway);
    const principal = { recoveryScope: "original", recoveryScopeReady: true };
    const expectedOwner = principal as GatewayBrowserClient;
    gateway.snapshot.client = expectedOwner;
    const first = storedAttachment("first-scope", "image/png", true);
    const second = storedAttachment("second-scope", "image/png", true);
    prepare(handoff, expectedOwner, "p1", "agent:main:one", [first]);
    prepare(handoff, expectedOwner, "p1", "agent:main:two", [second]);

    if (change === "principal") {
      principal.recoveryScope = "other";
    }
    expect(
      consume(
        handoff,
        change === "gateway" ? ({} as GatewayBrowserClient) : expectedOwner,
        "p1",
        "agent:main:two",
      ),
    ).toBeNull();
    expect(getChatAttachmentDataUrl(second)).toBeNull();
    expect(getChatAttachmentDataUrl(first)).not.toBeNull();
    principal.recoveryScope = "original";
    const retained = consume(handoff, expectedOwner, "p1", "agent:main:one");
    if (change === "principal") {
      expect(retained).toBeNull();
      expect(getChatAttachmentDataUrl(first)).toBeNull();
      const fresh = storedAttachment("fresh-principal", "image/png", true);
      prepare(handoff, expectedOwner, "p1", "agent:main:one", [fresh]);
      expect(consume(handoff, expectedOwner, "p1", "agent:main:one")).toEqual({
        attachments: [fresh],
        fallbacks: {},
      });
    } else {
      expect(retained).toEqual({ attachments: [first], fallbacks: {} });
    }
  },
);

it("does not let an empty retained session teardown erase another scope", () => {
  const handoff = handoffFor();
  const owner = {} as GatewayBrowserClient;
  const annotation = storedAttachment("overlapping-scope", "image/png", true);
  prepare(handoff, owner, "p1", "agent:main:one", [annotation]);
  prepare(handoff, owner, "p1", "agent:main:two", []);

  expect(consume(handoff, owner, "p1", "agent:main:one")?.attachments).toEqual([annotation]);
});

it("bounds abandoned entries and releases pane-clear and application disposal", () => {
  const owner = {} as GatewayBrowserClient;
  const handoff = handoffFor();
  const oversized = Array.from({ length: 33 }, (_, index) =>
    storedAttachment(`oversized-${index}`, "image/png", false),
  );
  prepare(handoff, owner, "oversized", "oversized", oversized);
  expect(consume(handoff, owner, "oversized", "oversized")?.attachments).toEqual(oversized);
  expect(getChatAttachmentDataUrl(oversized[32]!)).not.toBeNull();

  const annotations = Array.from({ length: 33 }, (_, index) =>
    storedAttachment(`bounded-${index}`, "image/png", true),
  );
  annotations.forEach((annotation, index) =>
    prepare(handoff, owner, `p${index}`, `scope-${index}`, [annotation]),
  );

  expect(getChatAttachmentDataUrl(annotations[0]!)).toBeNull();
  expect(getChatAttachmentDataUrl(annotations[1]!)).not.toBeNull();
  handoff.clearPane("p1");
  expect(getChatAttachmentDataUrl(annotations[1]!)).toBeNull();
  handoff.dispose();
  expect(getChatAttachmentDataUrl(annotations[32]!)).toBeNull();
});

it("releases a late prepare after application disposal instead of restaging it", () => {
  const handoff = handoffFor();
  const annotation = storedAttachment("late", "image/png", true);
  handoff.dispose();

  prepare(handoff, {} as GatewayBrowserClient, "p1", "agent:main:one", [annotation]);

  expect(getChatAttachmentDataUrl(annotation)).toBeNull();
  expect(consume(handoff, {} as GatewayBrowserClient, "p1", "agent:main:one")).toBeNull();
});
