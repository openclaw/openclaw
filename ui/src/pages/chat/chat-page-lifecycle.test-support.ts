import { afterEach, beforeEach, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { setNavigationContext, settleChatPage, stubMatchMedia } from "./chat-page.test-support.ts";

export function useChatPageFixture(restoreMocks = false) {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
  });
  afterEach(() => {
    document.body.replaceChildren();
    if (restoreMocks) {
      vi.restoreAllMocks();
    }
    vi.unstubAllGlobals();
  });
}

export function createChatPageFixture(sessionKey = "agent:main:current") {
  const page = document.createElement("openclaw-chat-page");
  const navigation = setNavigationContext(page);
  page.data = { sessionKey };
  const settle = () => settleChatPage(page);
  return {
    page,
    navigation,
    settle,
    mount: async () => {
      document.body.append(page);
      await settle();
    },
  };
}
