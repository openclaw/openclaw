/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createFrameClock } from "../../test-helpers/animation-frame-clock.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNoopSidebarRegionCallbacks } from "../../test-helpers/sidebar-region-callbacks.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionContext,
} from "./chat-application-context.test-support.ts";
import { PaneLayout } from "./chat-pane-layout-view.tsx";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  cleanupSolid();
  resetChatViewState();
  resetTranscriptTestDom();
  vi.useRealTimers();
});

it("defers hidden transcripts, retains revealed content, and cancels a closed pane's mount", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = createFrameClock();
  vi.stubGlobal("requestAnimationFrame", clock.request);
  vi.stubGlobal("cancelAnimationFrame", clock.cancel);
  const context = createSessionContext(createGatewayBrowserClientFixture());
  const provider = createSolidApplicationContextProvider(context);
  const callbacks = createNoopSidebarRegionCallbacks();
  const paint = async () => {
    clock.flush(performance.now());
    await Promise.resolve();
    flush();
  };
  const settlePaints = async () => {
    for (let frame = 0; frame < 4; frame += 1) {
      await paint();
      await vi.advanceTimersByTimeAsync(0);
      flush();
    }
  };
  function mountPane(paneId: string, restoring = false, messageCount = 1) {
    const chat = createChatProps({
      paneId,
      sessionKey: `agent:main:${paneId}`,
      messages: Array.from({ length: messageCount }, (_, index) => ({
        role: "assistant",
        content: "Initial history",
        timestamp: index + 1,
      })),
      restoring,
    });
    chat.transcript.start();
    onTestFinished(() => chat.transcript.dispose());
    const [state, setState] = createSignal({ presented: true, chat });
    const view = mountSolid(
      () => {
        const questions = createComposerQuestions(paneId, () => state().chat);
        return (
          <PaneLayout
            questions={questions}
            layout={{
              region: {
                panelIdPrefix: paneId,
                presentationId: paneId,
                availableWidth: 1_400,
                narrow: false,
                layout: { columns: [] },
                panelDefinitions: [],
                callbacks,
              },
              header: null,
              subagentHeader: null,
              primary: {
                chat: {
                  ...state().chat,
                  presented: state().presented,
                  transcriptVisible: state().presented,
                },
                application: context,
              },
              background: { surface: "session" },
              overlays: {
                presentation: state().presented,
                image: null,
                onCloseImage: () => {},
                reset: null,
              },
            }}
          />
        );
      },
      { wrapper: provider.wrapper },
    );
    flush();
    return {
      ...view,
      chat,
      update: (patch: Partial<ReturnType<typeof state>>) => {
        setState((current) => ({ ...current, ...patch }));
        flush();
      },
    };
  }

  const pane = mountPane("mount-reveal");
  const composer = pane.getByRole<HTMLTextAreaElement>("textbox");
  const viewport = pane.container.querySelector(".chat-thread-viewport");
  expect(viewport).not.toBeNull();
  expect(pane.container.querySelector(".chat-conversation-loading")).not.toBeNull();
  expect(pane.container.querySelector(".chat-thread--annotations")).not.toBeNull();
  await paint();
  expect(pane.container.querySelector(".chat-conversation-loading")).not.toBeNull();
  pane.update({ presented: false });
  await settlePaints();
  expect(pane.chat.transcript.renderedSessionKey).toBeNull();
  expect(pane.container.querySelector(".chat-virtual-row")).toBeNull();

  const latest = {
    ...pane.chat,
    messages: [{ role: "assistant", content: "Latest history", timestamp: 1 }],
  };
  pane.update({ presented: true, chat: latest });
  composer.focus();
  await paint();
  expect(pane.container.querySelector(".chat-conversation-loading")).not.toBeNull();
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(pane.container.querySelector(".chat-conversation-loading")).toBeNull();
  await settlePaints();
  expect(pane.container.textContent).toContain("Latest history");
  expect(pane.container.textContent).not.toContain("Initial history");
  expect(pane.container.querySelector(".chat-conversation-loading")).toBeNull();
  expect(pane.container.querySelector(".chat-thread-viewport")).toBe(viewport);
  const thread = pane.container.querySelector(".chat-thread");
  const row = pane.container.querySelector(".chat-virtual-row");
  expect(row).not.toBeNull();
  pane.update({ chat: { ...latest, assistantName: "Renamed assistant" } });
  pane.update({ presented: false });
  pane.update({ presented: true });
  await settlePaints();
  expect(pane.getByRole("textbox")).toBe(composer);
  expect(document.activeElement).toBe(composer);
  expect(pane.container.querySelector(".chat-thread")).toBe(thread);
  expect(pane.container.querySelector(".chat-thread-viewport")).toBe(viewport);
  expect(pane.container.querySelector(".chat-virtual-row")).toBe(row);
  expect(pane.container.querySelector(".chat-conversation-loading")).toBeNull();
  pane.unmount();

  const closed = mountPane("mount-cancelled");
  expect(closed.container.querySelector(".chat-conversation-loading")).not.toBeNull();
  await paint();
  closed.unmount();
  await settlePaints();
  expect(closed.chat.transcript.renderedSessionKey).toBeNull();
  expect(closed.container.querySelector(".chat-thread")).toBeNull();

  const restored = mountPane("mount-restored", true);
  expect(restored.container.querySelector('.chat-thread[role="log"]')).not.toBeNull();
  expect(restored.container.querySelector(".chat-conversation-loading")).toBeNull();
  restored.unmount();

  vi.stubGlobal("chrome", {});
  const preparing = mountPane("mount-preparing", false, 600);
  preparing.update({ chat: { ...preparing.chat, messages: [], loading: true } });
  await paint();
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(preparing.container.querySelector(".chat-virtual-row")).toBeNull();
  expect(preparing.container.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
  preparing.update({
    chat: { ...preparing.chat, messages: [], loading: true, routeLoadingSkeleton: true },
  });
  expect(preparing.container.querySelector(".lazy-view-state--loading")).not.toBeNull();
  preparing.update({ chat: preparing.chat });
  await vi.advanceTimersByTimeAsync(0);
  flush();
  // The composer is usable, but no partial history may reach the transcript.
  expect(preparing.getByRole<HTMLTextAreaElement>("textbox").disabled).toBe(false);
  expect(preparing.container.querySelector(".chat-virtual-row")).toBeNull();
  preparing.update({
    chat: {
      ...preparing.chat,
      messages: [{ role: "assistant", content: "Replacement history", timestamp: 1 }],
    },
  });
  await vi.advanceTimersByTimeAsync(1);
  await settlePaints();
  expect(preparing.container.textContent).toContain("Replacement history");
  expect(preparing.container.textContent).not.toContain("Initial history");
  preparing.unmount();

  const pending = mountPane("mount-pending", false, 0);
  pending.update({
    chat: {
      ...pending.chat,
      loading: true,
      queue: [
        { id: "first", text: "First turn", createdAt: 1, sendState: "failed", sendAttempts: 1 },
      ],
    },
  });
  await settlePaints();
  expect(pending.container.textContent).toContain("First turn");
  pending.unmount();
});
