/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { ValueSignal } from "../../lib/board/provider-signals.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import {
  createDetailsOutputsBinding,
  projectDetailsOutputs,
} from "./chat-details-outputs-binding.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { ChatOutputsDesktop, ChatOutputsMobile } from "./components/chat-outputs.tsx";
import { getSessionWorkspace } from "./components/chat-session-workspace-state.ts";

function boardFixture(sessionKey: string, initiallyLoaded = false) {
  const mock = createMockBoardProvider(sessionKey);
  const provider = {
    ...mock,
    hasLoadedSnapshot: initiallyLoaded,
    snapshot$: new ValueSignal<ResolvedBoardView["snapshot"]>({
      ...mock.snapshot$.value,
      tabs: [],
      widgets: [],
    }),
    loadError$: new ValueSignal<string | null>(null),
  };
  return {
    provider,
    fail: () => provider.loadError$.set("Dashboard request failed"),
    resolve(withContent = false) {
      provider.hasLoadedSnapshot = true;
      provider.snapshot$.set(withContent ? mock.snapshot$.value : provider.snapshot$.value);
      provider.loadError$.set(null);
    },
  };
}

function mountOutputs(
  options: { desktop?: boolean; acquired?: boolean; loaded?: boolean; files?: boolean } = {},
) {
  const { pane, state } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const workspace = getSessionWorkspace(state);
  workspace.assistantArtifacts = {
    items: options.files
      ? [{ id: "report", type: "file", title: "Report.txt", download: { mode: "bytes" } }]
      : [],
    resolved: true,
    loaded: true,
    loading: false,
    error: null,
  };
  let board = boardFixture(state.sessionKey, options.loaded);
  const readBoard = (): ResolvedBoardView => ({
    provider: board.provider,
    snapshot: board.provider.snapshot$.value,
    available: true,
    hasBoard: board.provider.snapshot$.value.widgets.length > 0,
    face: "chat",
    activeTabId: "main",
  });
  const openDashboard = vi.fn();
  const context = {
    gateway: () => pane.context.gateway,
    state: () => state,
    isConnected: () => true,
    presented: () => true,
    presentation: () => undefined,
    readBoard,
    showDashboard: openDashboard,
  };
  const bind = (acquired = true) =>
    createDetailsOutputsBinding(context, state, workspace, board.provider, acquired);
  let binding = bind(options.acquired);
  const read = () => projectDetailsOutputs(binding, workspace, readBoard()).outputs!;
  const [outputs, setOutputs] = createSignal(read());
  const draw = () => {
    setOutputs(read());
    flush();
  };
  const view = mountSolid(() =>
    options.desktop ? <ChatOutputsDesktop {...outputs()} /> : <ChatOutputsMobile {...outputs()} />,
  );
  onTestFinished(() => {
    binding.stop();
    view.unmount();
  });
  return {
    ...view,
    openDashboard,
    button: (name: string) => view.getByRole("button", { name }),
    status: (text?: string) =>
      waitForSolid(() => {
        if (text) {
          expect(view.getByRole("status").textContent).toContain(text);
        } else {
          expect(view.queryByRole("status")).toBeNull();
        }
      }),
    fail() {
      board.fail();
      draw();
    },
    resolve(withContent = false) {
      board.resolve(withContent);
      draw();
    },
    acquire() {
      binding.stop();
      binding = bind();
      draw();
    },
    replace() {
      const previous = board;
      binding.stop();
      board = boardFixture(state.sessionKey, true);
      board.resolve(true);
      binding = bind();
      draw();
      return previous;
    },
    retainAndReleaseFiles() {
      binding.retain()?.();
    },
  };
}

it("waits for acquisition even when the initial provider reports a loaded empty snapshot", async () => {
  const view = mountOutputs({ acquired: false, loaded: true });
  await view.status("Loading dashboard");
  expect(view.queryByText("No outputs yet")).toBeNull();
  view.acquire();
  await waitForSolid(() => expect(view.queryByText("Loading dashboard…")).toBeNull());
  expect(view.container.textContent).toContain("No outputs yet");
});

it.each([false, true])(
  "keeps files usable through dashboard failure and owner recovery (desktop=%s)",
  async (desktop) => {
    const view = mountOutputs({ desktop, files: true });
    await waitForSolid(() => expect(view.button("Report.txt")).toBeTruthy());
    view.fail();
    await view.status("Dashboard request failed");
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.button("Report.txt")).toBeTruthy();
    view.resolve(true);
    await view.status();
    view.button("Overview").click();
    expect(view.openDashboard).toHaveBeenCalledOnce();
  },
);

it("keeps dashboard readiness alive when Files demand is released and retires pending providers", async () => {
  const view = mountOutputs();
  view.retainAndReleaseFiles();
  await view.status("Loading dashboard");
  const previous = view.replace();
  await waitForSolid(() => expect(view.button("Overview")).toBeTruthy());
  previous.fail();
  previous.resolve();
  await view.status();
  expect(view.button("Overview")).toBeTruthy();
});
