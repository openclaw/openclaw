// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerFileReferenceFixture } from "../../lib/chat/file-references.test-support.ts";
import { storageTargetForComposer } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadChatComposerState, persistChatComposerState } from "./composer-draft-storage.ts";
import { ChatComposerPersistence } from "./composer-persistence.ts";
import {
  handleChatDraftChange,
  handleChatInputHistoryKey,
  type ChatInputHistoryState,
} from "./input-history.ts";

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => vi.unstubAllGlobals());
const references = [composerFileReferenceFixture];
const state = () => ({
  settings: { gatewayUrl: "ws://file-reference-storage.test/control" },
  sessionKey: "agent:main:reference",
  chatMessage: "@src/example.ts",
  chatFileReferences: references,
  chatAttachments: [],
  chatQueue: [],
  client: { recoveryScope: "reference-owner", recoveryScopeReady: true },
  connected: true,
});

it("restores identity with synchronous draft storage and explicitly clears it with equal text", () => {
  const source = state();
  expect(persistChatComposerState(source)).toBe(true);
  expect(JSON.parse(sessionStorage.getItem(storageTargetForComposer(source).key)!).version).toBe(5);
  const restored = { ...state(), chatMessage: "", chatFileReferences: [] };
  const persistence = new ChatComposerPersistence(() => restored);
  expect(persistence.restore()).toBe(true);
  expect(restored.chatMessage).toBe("@src/example.ts");
  expect(restored.chatFileReferences).toEqual(references);
  restored.chatFileReferences = [];
  expect(persistChatComposerState(restored)).toBe(true);
  expect(
    loadChatComposerState(restored, restored.sessionKey).snapshot?.fileReferences,
  ).toBeUndefined();
});

it("keeps unreadable future identity bytes intact through read and write attempts", () => {
  const source = state();
  expect(persistChatComposerState(source)).toBe(true);
  const key = storageTargetForComposer(source).key;
  const current = JSON.parse(sessionStorage.getItem(key)!);
  const stored = Object.values(current.sessions)[0] as { draftFileReferences: unknown };
  stored.draftFileReferences = [
    {
      ...composerFileReferenceFixture,
      reference: {
        ...composerFileReferenceFixture.reference,
        schemaVersion: 2,
        futureIdentity: "retain-me",
      },
    },
  ];
  const future = JSON.stringify(current);
  sessionStorage.setItem(key, future);
  expect(loadChatComposerState(source, source.sessionKey).snapshot).toBeNull();
  expect(
    persistChatComposerState({ ...source, chatMessage: "Replacement", chatFileReferences: [] }),
  ).toBe(false);
  expect(sessionStorage.getItem(key)).toBe(future);
});

it("keeps draft identity separate from same-text input history and explicit replacements", () => {
  const history: ChatInputHistoryState = {
    sessionKey: "agent:main:history",
    chatLoading: false,
    chatMessage: "@src/example.ts",
    chatFileReferences: references,
    chatMessages: [],
    chatLocalInputHistoryBySession: { "agent:main:history": [{ text: "@src/example.ts", ts: 1 }] },
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
  };
  const press = (key: "ArrowUp" | "ArrowDown") =>
    handleChatInputHistoryKey(history, {
      key,
      selectionStart: key === "ArrowUp" ? 0 : history.chatMessage.length,
      selectionEnd: key === "ArrowUp" ? 0 : history.chatMessage.length,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
    });
  expect(press("ArrowUp").handled).toBe(true);
  expect(history.chatFileReferences).toEqual([]);
  expect(press("ArrowDown").handled).toBe(true);
  expect(history.chatFileReferences).toEqual(references);
  handleChatDraftChange(history, history.chatMessage, [], []);
  expect(history.chatFileReferences).toEqual([]);
});
