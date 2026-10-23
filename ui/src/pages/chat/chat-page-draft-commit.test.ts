/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-draft.test/"} */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

// mock-isolation: the real ChatPage owns routing; a deferred child isolates its commit boundary from Gateway bootstrap.
vi.mock("./chat-pane.tsx", async () => {
  const { mockChatPagePane } = await import("./chat-page-pane.test-support.ts");
  return { ChatPaneView: mockChatPagePane };
});

import { createStorageMock } from "../../test-helpers/storage.ts";
import { setNavigationContext, stubMatchMedia } from "./chat-page.test-support.ts";
import "./chat-page.tsx";

let childCommit: Promise<void> | undefined;

class DraftCommitPane extends HTMLElement {
  private readonly textarea = Object.assign(document.createElement("textarea"), {
    value: "Scoped Home draft",
  });
  private draftValue: string | undefined;
  private updatePending = false;
  updateComplete = Promise.resolve(true);

  get draft() {
    return this.draftValue;
  }

  set draft(value: string | undefined) {
    if (value === this.draftValue) {
      return;
    }
    this.draftValue = value;
    if (this.updatePending) {
      return;
    }
    this.updatePending = true;
    this.updateComplete = Promise.resolve(childCommit).then(() => {
      if (this.draftValue !== undefined) {
        this.textarea.value = this.draftValue;
      }
      this.updatePending = false;
      return true;
    });
  }

  connectedCallback() {
    this.append(this.textarea);
  }
}

customElements.define("openclaw-chat-pane", DraftCommitPane);

afterEach(() => {
  childCommit = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps a route draft until its pane commits it", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  stubMatchMedia(false);
  window.history.replaceState({}, "", "/chat/main");
  const page = document.createElement("openclaw-chat-page");
  const { replace } = setNavigationContext(page);
  page.data = { sessionKey: "agent:main:main" };
  document.body.append(page);
  await page.updateComplete;
  const pane = page.querySelector<DraftCommitPane>("openclaw-chat-pane")!;
  await pane.updateComplete;
  expect(pane.querySelector("textarea")?.value).toBe("Scoped Home draft");

  const commit = createDeferred();
  childCommit = commit.promise;
  window.history.replaceState({}, "", "/chat/main?draft=What+can+you+do%3F");
  page.data = { sessionKey: "agent:main:main", draft: "What can you do?" };
  try {
    await page.updateComplete;
    await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();
    expect(pane.querySelector("textarea")?.value).toBe("Scoped Home draft");
  } finally {
    commit.resolve();
    await pane.updateComplete;
  }
  await page.updateComplete;
  expect(pane.querySelector("textarea")?.value).toBe("What can you do?");
  expect(replace).toHaveBeenCalledOnce();
});
