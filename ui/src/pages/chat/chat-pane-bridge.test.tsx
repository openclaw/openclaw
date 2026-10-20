/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
} from "./chat-pane.test-support.ts";
import { ChatPaneView, type ChatPaneElement } from "./chat-pane.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

it("exposes the current navigation face through the real pane host without a gateway read", async () => {
  // Keep this boundary test on bridge properties and the real navigation method.
  // Full pane startup/retirement is covered by the mounted lifecycle suites.
  const connected = vi.spyOn(ChatPaneRuntime.prototype, "start").mockImplementation(() => {});
  const disconnected = vi.spyOn(ChatPaneRuntime.prototype, "dispose").mockImplementation(() => {});
  onTestFinished(() => {
    connected.mockRestore();
    disconnected.mockRestore();
  });
  const request = vi.fn(async () => ({}));
  const context = createInitializationContext(createGatewayBrowserClientFixture({ request }));
  context.gateway.snapshot.phase = "stopped";
  const [face, setFace] = createSignal<"chat" | "dashboard">("chat");
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <ChatPaneView paneId="bridge-navigation" sessionKey="agent:main:bridge" routeFace={face()} />
    </ApplicationProvider>
  ));
  const pane = view.container.querySelector<ChatPaneElement>("openclaw-chat-pane");
  expect(pane).not.toBeNull();
  await waitForSolid(() => expect(pane?.captureNavigationFace()).toBe("chat"));

  setFace("dashboard");
  await waitForSolid(() => expect(pane?.captureNavigationFace()).toBe("dashboard"));
  setFace("chat");
  await waitForSolid(() => expect(pane?.captureNavigationFace()).toBe("chat"));
  expect(request).not.toHaveBeenCalled();
  view.unmount();
});

it("applies a route draft and its focus cue to an already mounted native pane", async () => {
  installTranscriptDomMocks();
  onTestFinished(resetTranscriptTestDom);
  const intervals = vi.spyOn(globalThis, "setInterval");
  const clearInterval = vi.spyOn(globalThis, "clearInterval");
  onTestFinished(() => {
    intervals.mockRestore();
    clearInterval.mockRestore();
  });
  const renderProbe = vi.fn<(host: object, phase: "invalidate" | "commit") => void>();
  vi.stubGlobal("openclawRenderLifecycleTestHook", renderProbe);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const sessionKey = "agent:main:bridge-draft";
  const fixture = createMountedPanes([
    { key: sessionKey, kind: "direct", sessionId: "bridge-draft", updatedAt: 1 },
  ]);
  const [draft, setDraft] = createSignal<string | undefined>(undefined);
  const [focusComposer, setFocusComposer] = createSignal(false);
  const [presented, setPresented] = createSignal(true);
  const container = document.body.appendChild(createApplicationContextProvider(fixture.context));
  onTestFinished(() => container.remove());
  const view = mountSolid(
    () => (
      <ApplicationProvider value={fixture.context}>
        <ChatPaneView
          paneId="bridge-draft"
          sessionKey={sessionKey}
          active
          draft={draft()}
          focusComposer={focusComposer()}
          presented={presented()}
        />
      </ApplicationProvider>
    ),
    { container },
  );
  const textarea = await waitForSolid(() => {
    const input = view.container.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox textarea",
    );
    expect(input).not.toBeNull();
    return input!;
  });

  const pane = expectDefined(
    view.container.querySelector<ChatPaneElement>("openclaw-chat-pane"),
    "mounted native pane",
  );
  const runtime = await waitForSolid(() =>
    expectDefined(
      renderProbe.mock.calls.find(
        ([host, phase]) => phase === "commit" && Reflect.get(host, "element") === pane,
      )?.[0],
      "reported pane runtime",
    ),
  );
  expect(Reflect.get(runtime, "state")).toMatchObject({ sessionKey });
  expect(renderProbe).toHaveBeenCalledWith(pane, "commit");
  setDraft("What can you do?");
  setFocusComposer(true);
  await pane.updateComplete;
  expect(renderProbe).toHaveBeenCalledWith(runtime, "commit");
  expect(textarea.value).toBe("What can you do?");
  expect(document.activeElement).toBe(textarea);
  expect(textarea.closest(".agent-chat__input")?.classList).toContain(
    "agent-chat__input--prefill-attention",
  );
  const poll = intervals.mock.calls.findIndex(([, delay]) => delay === 60_000);
  expect(poll).toBeGreaterThanOrEqual(0);
  setPresented(false);
  await waitForSolid(() =>
    expect(clearInterval).toHaveBeenCalledWith(intervals.mock.results[poll]?.value),
  );
  const priorIntervals = intervals.mock.calls.length;
  setPresented(true);
  await pane.updateComplete;
  const resumedPoll = intervals.mock.calls.findIndex(
    ([, delay], index) => index >= priorIntervals && delay === 60_000,
  );
  expect(resumedPoll).toBeGreaterThanOrEqual(priorIntervals);
  expect(view.container.querySelector(".agent-chat__composer-combobox textarea")).toBe(textarea);
  view.unmount();
  expect(clearInterval).toHaveBeenCalledWith(intervals.mock.results[resumedPoll]?.value);
});

it("updates held Send as a mounted composer's draft changes between commands and ordinary input", async () => {
  installTranscriptDomMocks();
  onTestFinished(resetTranscriptTestDom);
  const sessionKey = "agent:main:held-send";
  const fixture = createMountedPanes([
    { key: sessionKey, kind: "direct", sessionId: "held-send", updatedAt: 1 },
  ]);
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
    pane.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox textarea"),
    "held composer input",
  );
  const send = expectDefined(
    pane.querySelector<HTMLButtonElement>(".chat-send-btn--send"),
    "held Send button",
  );
  const edit = async (draft: string) => {
    input.value = draft;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await pane.updateComplete;
    expect(pane.querySelector(".agent-chat__composer-combobox textarea")).toBe(input);
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
  const start = vi.spyOn(ChatPaneRuntime.prototype, "start").mockImplementation(() => {});
  const dispose = vi.spyOn(ChatPaneRuntime.prototype, "dispose").mockImplementation(() => {});
  const render = vi.spyOn(ChatPaneRuntime.prototype, "render");
  onTestFinished(() => {
    start.mockRestore();
    dispose.mockRestore();
    render.mockRestore();
  });
  const context = createInitializationContext();
  context.gateway.snapshot.phase = "stopped";
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <ChatPaneView paneId="clean-hidden" presented={false} />
    </ApplicationProvider>
  ));
  onTestFinished(view.unmount);
  const pane = expectDefined(
    view.container.querySelector<ChatPaneElement>("openclaw-chat-pane"),
    "hidden native pane",
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
  installTranscriptDomMocks();
  onTestFinished(resetTranscriptTestDom);
  let visibility: DocumentVisibilityState = "visible";
  const visibilityRead = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  onTestFinished(() => visibilityRead.mockRestore());
  const sessionKey = "agent:main:bridge-board-provider";
  const fixture = createMountedPanes([
    { key: sessionKey, kind: "direct", sessionId: "bridge-board-provider", updatedAt: 1 },
  ]);
  const first = createMockBoardProvider(sessionKey);
  const second = createMockBoardProvider(sessionKey);
  const subscribe = vi.spyOn(second.events, "subscribe");
  const container = document.body.appendChild(createApplicationContextProvider(fixture.context));
  onTestFinished(() => container.remove());
  const view = mountSolid(
    () => (
      <ApplicationProvider value={fixture.context}>
        <ChatPaneView
          paneId="bridge-board-provider"
          sessionKey={sessionKey}
          boardProvider={first}
        />
      </ApplicationProvider>
    ),
    { container },
  );
  onTestFinished(view.unmount);
  const pane = expectDefined(
    view.container.querySelector<ChatPaneElement>("openclaw-chat-pane"),
    "board native pane",
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
  installTranscriptDomMocks();
  onTestFinished(resetTranscriptTestDom);
  const sessionKey = "agent:main:bridge-provider-review";
  const review = {
    id: "bridge-review",
    runId: "bridge-paused-run",
    canContinue: true,
    explanation: "The agent tried to modify a synthetic file outside the selected project.",
    continuationMessage: "Continue only inside the selected project.",
  };
  const fixture = createMountedPanes([
    {
      key: sessionKey,
      agentId: "main",
      kind: "direct",
      sessionId: "bridge-provider-review",
      updatedAt: 1,
      providerReview: review,
    },
  ]);
  const container = document.body.appendChild(createApplicationContextProvider(fixture.context));
  onTestFinished(() => container.remove());
  const view = mountSolid(
    () => (
      <ApplicationProvider value={fixture.context}>
        <ChatPaneView paneId="bridge-provider-review" sessionKey={sessionKey} active />
      </ApplicationProvider>
    ),
    { container },
  );
  onTestFinished(view.unmount);
  const reviewButton = await waitForSolid(() =>
    expectDefined(
      view.container.querySelector<HTMLButtonElement>(".chat-provider-review button"),
      "mounted provider review action",
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
