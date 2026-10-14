/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { ShellLayoutOwner } from "../../app/shell-layout-owner.ts";
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

it("publishes workbench layout before the first pane update and retires its report", async () => {
  const content = document.body.appendChild(document.createElement("main"));
  content.className = "content content--chat";
  const layout = new ShellLayoutOwner();
  layout.contentRef(content);
  const connected = vi
    .spyOn(ChatPaneRuntime.prototype, "connectedCallback")
    .mockImplementation(() => {});
  const disconnected = vi
    .spyOn(ChatPaneRuntime.prototype, "disconnectedCallback")
    .mockImplementation(() => {});
  const observations: boolean[] = [];
  const update = vi.spyOn(ChatPaneRuntime.prototype, "performUpdate").mockImplementation(() => {
    observations.push(content.classList.contains("content--workbench"));
  });
  onTestFinished(() => {
    connected.mockRestore();
    disconnected.mockRestore();
    update.mockRestore();
    layout.contentRef(undefined);
    content.remove();
  });
  const context = createInitializationContext(
    createGatewayBrowserClientFixture({ request: vi.fn() }),
  );
  context.gateway.snapshot.phase = "stopped";
  const view = mountSolid(
    () => (
      <ApplicationProvider value={context}>
        <ChatPaneView paneId="workbench-layout" sessionKey="agent:main:layout" />
      </ApplicationProvider>
    ),
    { container: content },
  );
  await waitForSolid(() => expect(observations).not.toHaveLength(0));
  expect(observations.every(Boolean)).toBe(true);
  expect(layout.current.workbench).toBe(true);
  view.unmount();
  expect(layout.current.workbench).toBeUndefined();
  expect(content.classList.contains("content--workbench")).toBe(false);
});

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
  const sessionKey = "agent:main:bridge-draft";
  const fixture = createMountedPanes([
    { key: sessionKey, kind: "direct", sessionId: "bridge-draft", updatedAt: 1 },
  ]);
  const [draft, setDraft] = createSignal<string | undefined>(undefined);
  const [focusComposer, setFocusComposer] = createSignal(false);
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
  setDraft("What can you do?");
  setFocusComposer(true);
  await pane.updateComplete;
  expect(textarea.value).toBe("What can you do?");
  expect(document.activeElement).toBe(textarea);
  expect(textarea.closest(".agent-chat__input")?.classList).toContain(
    "agent-chat__input--prefill-attention",
  );
  view.unmount();
});
