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
});

it("defers hidden transcripts, retains revealed content, and cancels a closed pane's mount", async () => {
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
    }
  };
  function mountPane(paneId: string) {
    const chat = createChatProps({
      paneId,
      sessionKey: `agent:main:${paneId}`,
      messages: [{ role: "assistant", content: "Initial history", timestamp: 1 }],
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
  await paint();
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
});
