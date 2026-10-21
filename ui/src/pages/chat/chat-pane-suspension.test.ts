/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-suspension.test/"} */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createTestChatPane,
  connectPaneTestView,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import { loadChatComposerState } from "./composer-persistence.ts";

let visibility: DocumentVisibilityState;
const panes: TestChatPane[] = [];
beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}
function createPane() {
  const fixture = createTestChatPane({ client: createTestGatewayClient(async () => ({})) });
  fixture.pane.render = () => ({
    layout: null,
    capabilityDialogs: undefined,
    providerReviewSource: undefined,
  });
  panes.push(fixture.pane);
  return fixture;
}
afterEach(() => {
  for (const pane of panes.splice(0)) {
    Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
    pane.disconnectedCallback();
  }
  resetChatComposerState();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("pauses minute updates while hidden and refreshes once on return", async () => {
  vi.useFakeTimers();
  const { pane } = createPane();
  connectPaneTestView(pane);
  await pane.updateComplete;
  const render = vi.spyOn(pane, "render");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(render).toHaveBeenCalledOnce();
  setVisibility("hidden");
  render.mockClear();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(render).not.toHaveBeenCalled();
  setVisibility("visible");
  await pane.updateComplete;
  expect(render).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(render).toHaveBeenCalledTimes(2);
});

it("commits each retained presentation's live draft before the document can suspend", async () => {
  const presentations = ["first", "second"].map((name) => {
    const { pane, state } = createPane();
    Object.assign(pane, {
      paneId: "p1",
      presentationId: JSON.stringify(["p1", `agent:main:${name}`]),
    });
    const textarea = document.createElement("textarea");
    textarea.value = `${name} draft still being composed 雪`;
    getChatComposerState(pane.presentationId).composerTextarea = textarea;
    state.chatMessage = `${name} draft still being`;
    vi.spyOn(state, "handleChatDraftChange");
    const draft = pane.chatState.composerDraft;
    connectPaneTestView(pane);
    return { pane, draft, state, textarea };
  });
  await Promise.all(presentations.map(({ pane }) => pane.updateComplete));
  setVisibility("hidden");
  for (const { draft, state, textarea } of presentations) {
    expect(state.handleChatDraftChange).toHaveBeenCalledExactlyOnceWith(textarea.value);
    expect([state.chatMessage, draft.read().draft]).toEqual([textarea.value, textarea.value]);
  }
});

it("stores an ordinary committed draft on hide before its debounce runs", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", createStorageMock());
  const { pane, state } = createPane();
  state.settings = { ...state.settings, gatewayUrl: pane.context.gateway.connection.gatewayUrl };
  connectPaneTestView(pane);
  await pane.updateComplete;
  pane.chatState.composerPersistence.start();
  const draft = "unfinished later draft";
  const textarea = document.createElement("textarea");
  textarea.value = draft;
  getChatComposerState(pane.presentationId).composerTextarea = textarea;
  state.handleChatDraftChange(draft);
  expect(loadChatComposerState(state, state.sessionKey).snapshot?.draft ?? "").toBe("");
  setVisibility("hidden");
  expect(loadChatComposerState(state, state.sessionKey).snapshot?.draft).toBe(draft);
});
