/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import * as chatThreadBuild from "./chat-thread-build.ts";
import { renderChatPropsInto, stubAnimationFrames } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { ChatComposerPersistence } from "./composer-persistence.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  resetTranscriptTestDom();
  vi.useRealTimers();
});

it("keeps a 3,000-message transcript cached when typing publishes an unchanged outbox", () => {
  stubAnimationFrames();
  vi.useFakeTimers({ toNotFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("sessionStorage", createStorageMock());
  const build = vi.spyOn(chatThreadBuild, "buildChatItems");
  const { pane, state } = createRefreshChatPane();
  const container = createComposerContainer();
  state.sessionKey = "agent:main:projection-draft";
  state.chatMessage = "";
  state.chatMessages = Array.from({ length: 3_000 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `Message ${index}`,
    timestamp: index + 1,
    __openclaw: { id: `message-${index}`, seq: index + 1, runId: `run-${index >> 1}` },
  }));
  const unsubscribe = chatOutboxOwner(state).subscribe(state);
  const persistence = new ChatComposerPersistence(() => state);
  persistence.start();
  const project = () => {
    pane.render();
    renderChatPropsInto(container, expectDefined(pane.chatProps, "pane transcript props"));
  };
  try {
    project();
    expect(build).toHaveBeenCalled();
    build.mockClear();
    for (const draft of ["a", "ab", ""]) {
      state.handleChatDraftChange(draft);
      persistence.persistChangedState();
      project();
      expect(state.chatMessage).toBe(draft);
      expect(state.chatQueue).toEqual([]);
      expect(build).not.toHaveBeenCalled();
    }
  } finally {
    persistence.stop();
    unsubscribe();
    pane.chatProps?.transcript.hostDisconnected();
  }
});
