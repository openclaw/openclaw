// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  admitStoredChatComposerQueueItem,
  loadChatComposerSnapshot,
  type persistChatComposerState,
} from "./composer-persistence.ts";

type ComposerState = Parameters<typeof persistChatComposerState>[0];
function createState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "agent:lily:main",
    chatMessage: "",
    chatQueue: [],
    ...overrides,
  };
}

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => vi.unstubAllGlobals());

describe("failed attachment send persistence", () => {
  it("keeps failed attachment sends durable and retryable, including stack-overflow failures", () => {
    const state = createState();
    const failed: ChatQueueItem = {
      id: "overflow-attachment",
      text: "failed attachment send",
      createdAt: 1,
      sendState: "failed",
      sendError: "RangeError: Maximum call stack size exceeded",
      attachments: [
        {
          id: "att-overflow",
          mimeType: "image/png",
          fileName: "big.png",
          dataUrl: "data:image/png;base64,AAA",
        },
      ],
    };

    expect(
      admitStoredChatComposerQueueItem(
        state,
        captureChatOutboxAdmission(state, state.sessionKey),
        failed,
      ),
    ).toBe(true);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.queue).toMatchObject([
      {
        id: "overflow-attachment",
        sendState: "failed",
        sendError: "RangeError: Maximum call stack size exceeded",
        attachments: [{ id: "att-overflow" }],
      },
    ]);
  });

  it("preserves legacy failed sends, including attachment stack-overflow records", () => {
    const gatewayUrl = "ws://gateway.test/control";
    sessionStorage.setItem(
      `openclaw.control.chatComposer.v1:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:lily:main\u0000agent:lily": {
            updatedAt: 1,
            queue: [
              {
                id: "legacy-attachment-overflow",
                text: "legacy failed attachment send",
                createdAt: 1,
                sendState: "failed",
                sendError: "RangeError: Maximum call stack size exceeded",
                attachments: [
                  {
                    id: "att-legacy",
                    mimeType: "image/png",
                    fileName: "legacy.png",
                    dataUrl: "data:image/png;base64,AAA",
                  },
                ],
              },
              {
                id: "legacy-text-failure",
                text: "unrelated failed send",
                createdAt: 2,
                sendState: "failed",
                sendError: "gateway unreachable",
              },
            ],
          },
        },
      }),
    );

    const state = createState({ settings: { gatewayUrl } });
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.queue).toMatchObject([
      { id: "legacy-attachment-overflow", sendState: "failed" },
      { id: "legacy-text-failure", sendState: "failed", sendError: "gateway unreachable" },
    ]);
  });
});
