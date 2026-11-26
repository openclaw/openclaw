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
import * as transcriptProjection from "./components/chat-transcript-projection.ts";
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

function createPaneMountFixture() {
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
  function mountPane(
    paneId: string,
    restoring = false,
    initialSubmission = false,
    overrides: Partial<ReturnType<typeof createChatProps>> = {},
  ) {
    const chat = createChatProps({
      paneId,
      sessionKey: `agent:main:${paneId}`,
      selectedSession: { key: `agent:main:${paneId}`, kind: "direct", hasMessages: true },
      messages: [{ role: "assistant", content: "Initial history", timestamp: 1 }],
      restoring,
      initialSubmission,
      ...overrides,
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

  return { mountPane, paint, settlePaints };
}

it.each([false, true])("owns transcript mounts (restoring=%s)", async (isRestoring) => {
  const { mountPane, paint, settlePaints } = createPaneMountFixture();
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

  const created = mountPane("mount-created", false, true);
  expect(created.container.querySelector('.chat-thread[role="log"]')).not.toBeNull();
  expect(created.container.querySelector(".chat-conversation-loading")).toBeNull();
  created.unmount();

  document.documentElement.setAttribute("data-openclaw-warm-frame", "holding");
  const warmYield = Promise.withResolvers<void>();
  vi.stubGlobal("scheduler", { yield: () => warmYield.promise });
  const warm = mountPane("mount-held-warm", isRestoring);
  const warmComposer = warm.getByRole("textbox");
  expect(warm.container.querySelector('.chat-thread[role="log"]')).toBeNull();
  expect(warm.container.querySelector(".chat-conversation-loading")).toBeNull();
  warm.update({ chat: { ...warm.chat, messages: latest.messages } });
  document.documentElement.setAttribute("data-openclaw-warm-frame", "fallback");
  warmYield.resolve();
  await warmYield.promise;
  flush();
  expect(warm.getByRole("textbox")).toBe(warmComposer);
  expect(warm.container.querySelector('.chat-thread[role="log"]')).not.toBeNull();
  await settlePaints();
  expect(warm.container.textContent).toContain("Latest history");
  expect(warm.container.textContent).not.toContain("Initial history");
  warm.unmount();

  document.documentElement.setAttribute("data-openclaw-warm-frame", "holding");
  const closedWarmYield = Promise.withResolvers<void>();
  vi.stubGlobal("scheduler", { yield: () => closedWarmYield.promise });
  const closedWarm = mountPane("mount-closed-warm", isRestoring);
  closedWarm.unmount();
  closedWarmYield.resolve();
  await closedWarmYield.promise;
  flush();
  expect(closedWarm.chat.transcript.renderedSessionKey).toBeNull();

  const warmCreated = mountPane("mount-held-created", isRestoring, true);
  expect(warmCreated.container.querySelector('.chat-thread[role="log"]')).not.toBeNull();
  expect(warmCreated.container.querySelector(".chat-conversation-loading")).toBeNull();
  warmCreated.unmount();
});

function simulateProjectionCost(cost: number) {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const project = transcriptProjection.projectChatTranscript;
  vi.spyOn(transcriptProjection, "projectChatTranscript").mockImplementation((...args) => {
    const result = project(...args);
    if (!result.isEmpty && !result.isLoading) {
      now += cost;
    }
    return result;
  });
  return (milliseconds: number) => {
    now += milliseconds;
  };
}

it("splits the first costly history after the loading shell has settled", async () => {
  const { mountPane, settlePaints } = createPaneMountFixture();
  const elapse = simulateProjectionCost(16);
  const pending = Promise.withResolvers<void>();
  const yieldTask = vi.fn(() => pending.promise);
  vi.stubGlobal("scheduler", { yield: yieldTask });
  const pane = mountPane("late-history", false, false, { messages: [], loading: true });
  await settlePaints();
  const composer = pane.getByRole<HTMLTextAreaElement>("textbox");
  const viewport = pane.container.querySelector(".chat-thread-viewport");
  composer.focus();
  expect(pane.container.querySelector(".chat-thread-inner")).not.toBeNull();
  expect(pane.container.querySelector(".chat-virtual-row")).toBeNull();
  expect(yieldTask).not.toHaveBeenCalled();
  // Empty receipts and time waiting for history must not spend the preparation budget.
  elapse(1_000);
  pane.update({ chat: { ...pane.chat, messages: [], loading: false } });
  expect(pane.container.querySelector(".agent-chat__empty")).not.toBeNull();
  expect(yieldTask).not.toHaveBeenCalled();
  const history = {
    ...pane.chat,
    loading: false,
    messages: [{ role: "assistant", content: "First arriving history", timestamp: 1 }],
  };
  pane.update({ chat: history });
  expect(pane.container.querySelector(".chat-virtual-row")).toBeNull();
  expect(yieldTask).toHaveBeenCalledTimes(1);
  expect(pane.getByRole("textbox")).toBe(composer);
  expect(document.activeElement).toBe(composer);
  expect(pane.container.querySelector(".chat-thread-viewport")).toBe(viewport);
  // A second receipt during the one yield supplies the rows without another yield.
  const latest = { ...history, messages: [{ ...history.messages[0]!, content: "Latest history" }] };
  pane.update({ chat: latest });
  expect(yieldTask).toHaveBeenCalledTimes(1);
  pending.resolve();
  await pending.promise;
  flush();
  await settlePaints();
  expect(pane.container.textContent).toContain("Latest history");
  expect(pane.container.textContent).not.toContain("First arriving history");
  const row = pane.container.querySelector(".chat-virtual-row");
  expect(row).not.toBeNull();
  const yielded = yieldTask.mock.calls.length;
  pane.update({ chat: { ...latest, assistantName: "Renamed assistant" } });
  expect(pane.container.querySelector(".chat-virtual-row")).toBe(row);
  expect(yieldTask).toHaveBeenCalledTimes(yielded);
});

it.each([
  { name: "cheap first history", cost: 15, restoring: false, initial: false, late: false },
  { name: "restored history", cost: 16, restoring: true, initial: false, late: false },
  { name: "initial submission", cost: 16, restoring: false, initial: true, late: false },
  { name: "later accepted submission", cost: 16, restoring: false, initial: false, late: true },
])("keeps $name immediate after an empty shell", async ({ cost, restoring, initial, late }) => {
  const { mountPane, settlePaints } = createPaneMountFixture();
  const elapse = simulateProjectionCost(cost);
  const pending = Promise.withResolvers<void>();
  const yieldTask = vi.fn(() => pending.promise);
  vi.stubGlobal("scheduler", { yield: yieldTask });
  const pane = mountPane("immediate-history", restoring, initial, { messages: [], loading: true });
  await settlePaints();
  elapse(1_000);
  pane.update({
    chat: {
      ...pane.chat,
      loading: false,
      initialSubmission: initial || late,
      messages: [{ role: "assistant", content: "Immediate history", timestamp: 1 }],
    },
  });
  expect(pane.container.querySelector(".chat-virtual-row")).not.toBeNull();
  expect(pane.container.textContent).toContain("Immediate history");
  expect(yieldTask).not.toHaveBeenCalled();
  pane.unmount();
  pending.resolve();
});

it("retires the costly first-row task when the pane closes", async () => {
  const { mountPane, settlePaints } = createPaneMountFixture();
  simulateProjectionCost(16);
  const pending = Promise.withResolvers<void>();
  const yieldTask = vi.fn(() => pending.promise);
  vi.stubGlobal("scheduler", { yield: yieldTask });
  const pane = mountPane("closed-first-rows");
  await settlePaints();
  expect(yieldTask).toHaveBeenCalledTimes(1);
  expect(pane.container.querySelector(".chat-virtual-row")).toBeNull();
  const prepared = vi.mocked(transcriptProjection.projectChatTranscript).mock.results.at(-1)!;
  const renderRows = vi.spyOn(prepared.value, "renderRows");
  pane.unmount();
  pending.resolve();
  await pending.promise;
  flush();
  expect(renderRows).not.toHaveBeenCalled();
  expect(pane.container.querySelector(".chat-thread")).toBeNull();
});
