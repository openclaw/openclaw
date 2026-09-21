/* @vitest-environment jsdom */
import type { ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canReloadControlUiDocument } from "../../app/document-reload-guard.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import { enqueueChatMessage } from "./chat-queue.ts";
import { OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import {
  beginQueuedMessageEdit,
  QUEUED_MESSAGE_EDIT_CONFLICT_ERROR,
} from "./queued-message-edit.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createControllerHost(): ReactiveControllerHost {
  return {
    addController: () => undefined,
    removeController: () => undefined,
    requestUpdate: () => undefined,
    updateComplete: Promise.resolve(true),
  };
}

describe("queued edit page callbacks", () => {
  it.each([
    [QUEUED_MESSAGE_EDIT_CONFLICT_ERROR, QUEUED_MESSAGE_EDIT_CONFLICT_ERROR, null, null],
    [
      QUEUED_MESSAGE_EDIT_CONFLICT_ERROR,
      OFFLINE_QUEUE_STORAGE_ERROR,
      null,
      OFFLINE_QUEUE_STORAGE_ERROR,
    ],
    [
      "History could not be refreshed",
      OFFLINE_QUEUE_STORAGE_ERROR,
      "History could not be refreshed",
      OFFLINE_QUEUE_STORAGE_ERROR,
    ],
  ] as const)(
    "clears only resolved edit feedback when opening a queued editor (%s, %s)",
    (lastError, chatError, expectedLastError, expectedChatError) => {
      const controller = new ChatStateController<ChatPageHost>(createControllerHost());
      controller.hostConnected();
      const state = createPageState(
        createInitializationContext(),
        controller.createRenderLifecycle(),
        {
          dispatchEvent: () => true,
          querySelector: () => null,
        },
      );
      controller.attach(state);
      try {
        const queued = enqueueChatMessage(state, "queued original")!;
        state.chatMessage = "separate composer draft";
        state.lastError = lastError;
        state.chatError = chatError;

        state.editQueuedChatMessage(queued.id);

        expect(state.chatQueuedEdit?.draftText).toBe("queued original");
        expect(state.chatMessage).toBe("separate composer draft");
        expect(state.lastError).toBe(expectedLastError);
        expect(state.chatError).toBe(expectedChatError);
      } finally {
        controller.hostDisconnected();
      }
    },
  );

  it("releases a queued correction reload hold when its pane is disposed", () => {
    const controller = new ChatStateController<ChatPageHost>(createControllerHost());
    controller.hostConnected();
    const state = createPageState(
      createInitializationContext(),
      controller.createRenderLifecycle(),
      {
        dispatchEvent: () => true,
        querySelector: () => null,
      },
    );
    controller.attach(state);
    try {
      const queued = enqueueChatMessage(state, "queued original")!;
      expect(beginQueuedMessageEdit(state, queued.id)).toBe("started");
      expect(canReloadControlUiDocument()).toBe(false);
    } finally {
      controller.hostDisconnected();
    }
    expect(canReloadControlUiDocument()).toBe(true);
  });
});
