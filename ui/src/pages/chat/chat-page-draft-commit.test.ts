/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-draft.test/"} */
import { html, LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

// mock-isolation: the real ChatPage owns routing; a deferred Lit child isolates its commit boundary from Gateway bootstrap.
vi.mock("./chat-pane.ts", () => ({}));

import { createStorageMock } from "../../test-helpers/storage.ts";
import { setNavigationContext, stubMatchMedia } from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";

let childCommit: Promise<void> | undefined;

class DraftCommitPane extends LitElement {
  static override properties = { draft: { attribute: false } };
  declare draft: string | undefined;
  private message = "Scoped Home draft";

  override createRenderRoot() {
    return this;
  }

  protected override async scheduleUpdate() {
    await childCommit;
    await super.scheduleUpdate();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("draft") && this.draft !== undefined) {
      this.message = this.draft;
    }
  }

  override render() {
    return html`<textarea .value=${this.message}></textarea>`;
  }
}

customElements.define("openclaw-chat-pane", DraftCommitPane);

afterEach(() => {
  childCommit = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps a route draft until its Lit pane commits it", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  stubMatchMedia(false);
  window.history.replaceState({}, "", "/chat/main");
  const page = new ChatPage();
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
