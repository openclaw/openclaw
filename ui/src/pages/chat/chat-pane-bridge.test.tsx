/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
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
  const connected = vi
    .spyOn(ChatPaneRuntime.prototype, "connectedCallback")
    .mockImplementation(() => {});
  const disconnected = vi
    .spyOn(ChatPaneRuntime.prototype, "disconnectedCallback")
    .mockImplementation(() => {});
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
  expect(renderProbe).toHaveBeenCalledWith(runtime, "invalidate");
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
