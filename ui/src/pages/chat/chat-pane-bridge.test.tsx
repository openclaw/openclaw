/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import { ChatPaneView, type ChatPaneElement, type ChatPaneProps } from "./chat-pane.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

function mountedFixture(
  id: string,
  row: Partial<Parameters<typeof createMountedPanes>[0][number]> = {},
) {
  installTranscriptDomMocks();
  onTestFinished(resetTranscriptTestDom);
  const sessionKey = `agent:main:${id}`;
  const fixture = createMountedPanes([
    { key: sessionKey, kind: "direct", sessionId: id, updatedAt: 1, ...row },
  ]);
  return {
    ...fixture,
    sessionKey,
    render: (props: Partial<ChatPaneProps> = {}) =>
      mountPane(fixture.context, () => (
        <ChatPaneView paneId={id} sessionKey={sessionKey} {...props} />
      )),
  };
}

function mountPane(context: ApplicationContext, render: () => JSX.Element, nativeContext = true) {
  const container = nativeContext
    ? document.body.appendChild(createApplicationContextProvider(context))
    : undefined;
  onTestFinished(() => container?.remove());
  return mountSolid(() => <ApplicationProvider value={context}>{render()}</ApplicationProvider>, {
    container,
  });
}

const composerSelector = ".agent-chat__composer-combobox textarea";

function stubLifecycle() {
  vi.spyOn(ChatPaneRuntime.prototype, "start").mockImplementation(() => {});
  vi.spyOn(ChatPaneRuntime.prototype, "dispose").mockImplementation(() => {});
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
}

it("applies a route draft and its focus cue to an already mounted native pane", async () => {
  const intervals = vi.spyOn(globalThis, "setInterval");
  const clearInterval = vi.spyOn(globalThis, "clearInterval");
  const { sessionKey, context } = mountedFixture("bridge-draft");
  const [props, setProps] = createSignal<Partial<ChatPaneProps>>({ active: true, presented: true });
  const view = mountPane(context, () => (
    <ChatPaneView paneId="bridge-draft" sessionKey={sessionKey} {...props()} />
  ));
  const textarea = await waitForSolid(() =>
    expectDefined(
      view.container.querySelector<HTMLTextAreaElement>(composerSelector),
      composerSelector,
    ),
  );
  const pane = expectDefined(
    view.container.querySelector<ChatPaneElement>("openclaw-chat-pane"),
    "openclaw-chat-pane",
  );
  setProps((p) => ({ ...p, draft: "What can you do?", focusComposer: true }));
  await pane.updateComplete;
  expect(textarea.value).toBe("What can you do?");
  expect(document.activeElement).toBe(textarea);
  expect(textarea.closest(".agent-chat__input")?.classList).toContain(
    "agent-chat__input--prefill-attention",
  );
  const poll = intervals.mock.calls.findIndex(([, delay]) => delay === 60_000);
  expect(poll).toBeGreaterThanOrEqual(0);
  setProps((p) => ({ ...p, presented: false }));
  await waitForSolid(() =>
    expect(clearInterval).toHaveBeenCalledWith(intervals.mock.results[poll]?.value),
  );
  const priorIntervals = intervals.mock.calls.length;
  setProps((p) => ({ ...p, presented: true }));
  await pane.updateComplete;
  const resumedPoll = intervals.mock.calls.findIndex(
    ([, delay], index) => index >= priorIntervals && delay === 60_000,
  );
  expect(resumedPoll).toBeGreaterThanOrEqual(priorIntervals);
  expect(view.container.querySelector(composerSelector)).toBe(textarea);
  view.unmount();
  expect(clearInterval).toHaveBeenCalledWith(intervals.mock.results[resumedPoll]?.value);
});

it("updates held Send as a mounted composer's draft changes between commands and ordinary input", async () => {
  const fixture = mountedFixture("held-send");
  const { sessionKey } = fixture;
  const client = expectDefined(fixture.context.gateway.snapshot.client, "recovering client");
  Object.defineProperty(client, "recoveryScopeReady", { value: false });
  const container = document.body.appendChild(createApplicationContextProvider(fixture.context));
  onTestFinished(() => container.remove());
  const pane = fixture.mount(sessionKey);
  container.appendChild(pane.element);
  await pane.updateComplete;
  const sendChat = vi.spyOn(pane.state, "handleSendChat").mockResolvedValue(undefined);
  pane.state.handleChatDraftChange("/stop");
  await pane.updateComplete;
  const input = expectDefined(
    pane.querySelector<HTMLTextAreaElement>(composerSelector),
    composerSelector,
  );
  const send = expectDefined(
    pane.querySelector<HTMLButtonElement>(".chat-send-btn--send"),
    ".chat-send-btn--send",
  );
  const edit = async (draft: string) => {
    input.value = draft;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await pane.updateComplete;
    expect(pane.querySelector(composerSelector)).toBe(input);
  };

  expect(send.disabled).toBe(false);
  await edit("Keep this ordinary draft");
  expect(input.value).toBe("Keep this ordinary draft");
  expect(send.disabled).toBe(true);
  send.click();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(sendChat).not.toHaveBeenCalled();

  await edit("/approve approval-123 allow-once");
  expect(send.disabled).toBe(false);
  send.click();
  expect(sendChat).toHaveBeenCalledOnce();
});

it("settles clean hidden reads and fences actual property changes until reveal", async () => {
  stubLifecycle();
  const render = vi.spyOn(ChatPaneRuntime.prototype, "render");
  const context = createInitializationContext();
  context.gateway.snapshot.phase = "stopped";
  const view = mountPane(
    context,
    () => <ChatPaneView paneId="clean-hidden" presented={false} />,
    false,
  );
  const pane = expectDefined(
    view.container.querySelector<ChatPaneElement>("openclaw-chat-pane"),
    "openclaw-chat-pane",
  );
  await pane.updateComplete;
  await expect(pane.updateComplete).resolves.toBe(true);
  render.mockClear();
  pane.paneLabel = "Changed while hidden";
  let committed = false;
  const completion = pane.updateComplete.then(() => {
    committed = true;
  });
  await waitForSolid(() => {
    expect(render).not.toHaveBeenCalled();
    expect(committed).toBe(false);
  });
  pane.presented = true;
  await completion;
  expect(render).toHaveBeenCalledOnce();
});

it("replaces the command provider while document-hidden rendering is parked", async () => {
  let visibility: DocumentVisibilityState = "visible";
  const visibilitySpy = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  onTestFinished(() => visibilitySpy.mockRestore());
  const { sessionKey, render } = mountedFixture("bridge-board-provider");
  const first = createMockBoardProvider(sessionKey);
  const second = createMockBoardProvider(sessionKey);
  const subscribe = vi.spyOn(second.events, "subscribe");
  const view = render({ boardProvider: first });
  const pane = expectDefined(
    view.container.querySelector<ChatPaneElement>("openclaw-chat-pane"),
    "openclaw-chat-pane",
  );
  await pane.updateComplete;
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  pane.boardProvider = second;
  await waitForSolid(() => expect(subscribe).toHaveBeenCalledOnce());
  second.emitCommand({ kind: "focus_tab", tabId: "research" });
  expect(loadSettings().boardSessionViews?.[sessionKey]?.activeTabId).toBe("research");
  first.emitCommand({ kind: "focus_tab", tabId: "main" });
  expect(loadSettings().boardSessionViews?.[sessionKey]?.activeTabId).toBe("research");
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await pane.updateComplete;
});

it("opens provider findings through the mounted pane's first rendered frame", async () => {
  const review = {
    id: "bridge-review",
    runId: "bridge-paused-run",
    canContinue: true,
    explanation: "The agent tried to modify a synthetic file outside the selected project.",
    continuationMessage: "Continue only inside the selected project.",
  };
  const fixture = mountedFixture("bridge-provider-review", {
    agentId: "main",
    providerReview: review,
  });
  const view = fixture.render({ active: true });
  const reviewButton = await waitForSolid(() =>
    expectDefined(
      view.container.querySelector<HTMLButtonElement>(".chat-provider-review button"),
      ".chat-provider-review button",
    ),
  );
  expect(reviewButton.textContent).toContain("Review findings");
  reviewButton.click();
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    const dialog = view.container.querySelector("openclaw-modal-dialog");
    expect(dialog?.textContent).toContain(review.explanation);
    expect(dialog?.querySelector("blockquote")?.textContent).toBe(review.continuationMessage);
  });
});
