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
  document.documentElement.removeAttribute("data-openclaw-warm-frame");
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
  function mountPane(paneId: string, restoring = false) {
    const chat = createChatProps({
      paneId,
      sessionKey: `agent:main:${paneId}`,
      messages: [{ role: "assistant", content: "Initial history", timestamp: 1 }],
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

  document.documentElement.setAttribute("data-openclaw-warm-frame", "holding");
  const warmYield = Promise.withResolvers<void>();
  vi.stubGlobal("scheduler", { yield: () => warmYield.promise });
  const warm = mountPane("mount-held-warm", true);
  const warmComposer = warm.getByRole("textbox");
  expect(warm.container.querySelector('.chat-thread[role="log"]')).toBeNull();
  expect(warm.container.querySelector(".chat-conversation-loading")).toBeNull();
  warm.update({
    chat: {
      ...warm.chat,
      messages: [{ role: "assistant", content: "Admitted warm history", timestamp: 2 }],
    },
  });
  warmYield.resolve();
  await warmYield.promise;
  flush();
  expect(warm.getByRole("textbox")).toBe(warmComposer);
  expect(warm.container.querySelector('.chat-thread[role="log"]')).not.toBeNull();
  await settlePaints();
  expect(warm.container.textContent).toContain("Admitted warm history");
  expect(warm.container.textContent).not.toContain("Initial history");
  warm.unmount();

  const closedWarmYield = Promise.withResolvers<void>();
  vi.stubGlobal("scheduler", { yield: () => closedWarmYield.promise });
  const closedWarm = mountPane("mount-closed-warm", true);
  closedWarm.unmount();
  closedWarmYield.resolve();
  await closedWarmYield.promise;
  flush();
  expect(closedWarm.chat.transcript.renderedSessionKey).toBeNull();
});
