/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  registerControlUiReloadGuard as registerGuard,
  canReloadControlUiDocument,
} from "../../app/document-reload-guard.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createInitializationContext } from "./chat-application-context.test-support.ts";
import { storeChatComposerMemoryFallback } from "./chat-composer-memory-fallback.ts";
import { enqueueChatMessage } from "./chat-queue.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR as storageError } from "./chat-send-support.ts";
import { createChatState } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { QUEUED_MESSAGE_EDIT_CONFLICT_ERROR as conflict } from "./queued-message-edit.ts";

const recovery = vi.hoisted(() => ({
  review: vi.fn<() => Promise<boolean>>(),
  toast: vi.fn<(options: { onAction?: () => void; message: string }) => boolean>(() => true),
}));
const historyError = "History could not be refreshed";
const noop = () => {};
vi.mock("./components/private-composer-recovery-dialog.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./components/private-composer-recovery-dialog.tsx")>()),
  reviewPrivateComposerDraft: recovery.review,
}));
vi.mock("../../lib/toast.ts", () => ({ showToast: recovery.toast }));

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  recovery.review.mockReset();
  recovery.toast.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

function createControllerFixture(withClient = false) {
  const controller = createChatState<ChatPageHost>({ awaitDomCommit: async () => true });
  onTestFinished(controller.dispose);
  const state = createPageState(createInitializationContext(), controller.createRenderLifecycle(), {
    dispatchEvent: () => true,
  });
  if (withClient) {
    state.client = createTestGatewayClient(async () => ({}));
  }
  controller.attach(state);
  return { state, dispose: controller.dispose };
}

it.each([
  [conflict, conflict, null, null],
  [conflict, storageError, null, storageError],
  [historyError, storageError, historyError, storageError],
] as const)(
  "clears only edit feedback (%s, %s)",
  (lastError, chatError, expectedLastError, expectedChatError) => {
    const { state, dispose } = createControllerFixture(true);
    const queued = enqueueChatMessage(state, "queued")!;
    Object.assign(state, { chatMessage: "draft", lastError, chatError });

    state.editQueuedChatMessage(queued.id);

    expect(state).toMatchObject({ chatQueuedEdit: { draftText: "queued" }, chatMessage: "draft" });
    state.chatMessage = "";
    expect(canReloadControlUiDocument()).toBe(false);
    expect(state).toMatchObject({ lastError: expectedLastError, chatError: expectedChatError });
    dispose();
    expect(canReloadControlUiDocument()).toBe(true);
  },
);

it.each(["edit", "guard", "discard", "fallback"] as const)(
  "keeps private-draft discard scoped during %s",
  async (scenario) => {
    const { state, dispose } = createControllerFixture();
    const sessionKey = "agent:main:dashboard:incognito-private-review";
    state.sessionKey = sessionKey;
    state.chatMessage = "captured private text";
    if (scenario === "fallback") {
      const fallback = { message: "fallback", attachments: [] };
      storeChatComposerMemoryFallback(state, { sessionKey }, fallback);
      state.chatMessage = "";
    }
    const pending = createDeferred<boolean>();
    recovery.review.mockReturnValue(pending.promise);
    const reload = vi.fn(async () => canReloadControlUiDocument());
    state.captureComposerRecoveryReload = () => reload;
    const releaseOther = scenario === "guard" ? registerGuard(() => false, noop) : noop;
    onTestFinished(releaseOther);
    expect(canReloadControlUiDocument(true)).toBe(false);
    recovery.toast.mock.lastCall?.[0].onAction?.();
    expect(recovery.review).toHaveBeenCalledOnce();
    if (scenario === "edit") {
      state.handleChatDraftChange("newer private edit", []);
    }
    pending.resolve(true);
    await pending.promise;
    expect(state.chatMessage).toBe(scenario === "edit" ? "newer private edit" : "");
    if (scenario === "fallback") {
      expect(state.chatComposerFallbackByScope).toEqual({});
    }
    const outcomes = await Promise.all(reload.mock.results.map(({ value }) => value));
    expect(outcomes).toEqual(scenario === "edit" ? [] : [scenario !== "guard"]);
    if (scenario === "edit") {
      expect(recovery.toast.mock.lastCall?.[0].message).toContain("draft changed");
    }
    releaseOther();
    dispose();
    expect(canReloadControlUiDocument()).toBe(true);
  },
);
