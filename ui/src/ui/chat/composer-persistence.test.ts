// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import {
  loadChatComposerSnapshot,
  persistChatComposerState,
  restoreChatComposerState,
} from "./composer-persistence.ts";

function createState(overrides: Partial<Parameters<typeof persistChatComposerState>[0]> = {}) {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "agent:lily:main",
    chatMessage: "",
    chatQueue: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat composer persistence", () => {
  it("restores draft text and queued messages for the same gateway session", () => {
    const queue: ChatQueueItem[] = [
      {
        id: "queued-1",
        text: "follow up after tools finish",
        createdAt: 1,
        attachments: [
          {
            id: "att-1",
            mimeType: "image/png",
            fileName: "screen.png",
            dataUrl: "data:image/png;base64,AAA",
          },
        ],
      },
    ];
    persistChatComposerState(
      createState({
        chatMessage: "unsent draft",
        chatQueue: queue,
      }),
    );

    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);

    expect(restored.chatMessage).toBe("unsent draft");
    expect(restored.chatQueue).toEqual(queue);
  });

  it("scopes persisted composers by gateway and session key", () => {
    persistChatComposerState(createState({ chatMessage: "main draft" }));

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:other",
      ),
    ).toBeNull();
    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://other-gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toBeNull();
  });

  it("clears the stored session when both draft and queue are empty", () => {
    persistChatComposerState(createState({ chatMessage: "clear me" }));
    persistChatComposerState(createState());

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toBeNull();
  });

  it("does not restore queued attachments without payload data", () => {
    persistChatComposerState(
      createState({
        chatQueue: [
          {
            id: "queued-1",
            text: "needs attachment",
            createdAt: 1,
            attachments: [{ id: "att-1", mimeType: "image/png", fileName: "screen.png" }],
          },
        ],
      }),
    );

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toBeNull();
  });

  it("keeps in-memory queue items when the stored snapshot only has a draft", () => {
    persistChatComposerState(createState({ chatMessage: "stored draft" }));
    const restored = createState({
      chatQueue: [{ id: "queued-1", text: "memory queue", createdAt: 1 }],
    });

    expect(restoreChatComposerState(restored)).toBe(true);

    expect(restored.chatMessage).toBe("stored draft");
    expect(restored.chatQueue).toEqual([{ id: "queued-1", text: "memory queue", createdAt: 1 }]);
  });

  it("keeps failed queued messages failed after restore", () => {
    const failed: ChatQueueItem = {
      id: "failed-1",
      text: "manual retry only",
      createdAt: 1,
      sendError: "send blocked",
      sendRunId: "run-failed",
      sendState: "failed",
    };
    persistChatComposerState(createState({ chatQueue: [failed] }));

    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);

    expect(restored.chatQueue).toEqual([failed]);
  });

  it("does not restore in-flight sends that may already have reached the gateway", () => {
    persistChatComposerState(
      createState({
        chatQueue: [
          {
            id: "sending-1",
            text: "possibly already sent",
            createdAt: 1,
            sendRunId: "run-sending",
            sendState: "sending",
          },
        ],
      }),
    );

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toBeNull();
  });
});
