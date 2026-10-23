/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ArtifactSummary } from "../../../../packages/gateway-protocol/src/schema/artifacts.js";
import { ValueSignal } from "../../lib/board/provider-signals.ts";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createDetailsOutputsBinding,
  projectDetailsOutputs,
} from "./chat-details-outputs-binding.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { createGatewayBrowserClientFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatDetailsOutputs } from "./components/chat-details-types.ts";
import { ChatOutputsDesktop, ChatOutputsMobile } from "./components/chat-outputs.tsx";
import { getSessionWorkspace } from "./components/chat-session-workspace-state.ts";

function boardFixture(sessionKey: string, initiallyLoaded = false) {
  let loaded = initiallyLoaded;
  const mock = createMockBoardProvider(sessionKey);
  const snapshot$ = new ValueSignal<ResolvedBoardView["snapshot"]>({
    ...mock.snapshot$.value,
    tabs: [],
    widgets: [],
  });
  const loadError$ = new ValueSignal<string | null>(null);
  return {
    provider: {
      ...mock,
      snapshot$,
      loadError$,
      get hasLoadedSnapshot() {
        return loaded;
      },
    },
    fail() {
      loadError$.set("Dashboard request failed");
    },
    resolve(withContent = false) {
      loaded = true;
      snapshot$.set(withContent ? mock.snapshot$.value : snapshot$.value);
      loadError$.set(null);
    },
  };
}

function mountOutputs(
  options: { desktop?: boolean; acquired?: boolean; loaded?: boolean; files?: boolean } = {},
) {
  const request = vi.fn<GatewayRequestHandler>(async () => ({}));
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
  });
  const workspace = getSessionWorkspace(state);
  const artifact: ArtifactSummary = {
    id: "report",
    type: "file",
    title: "Report.txt",
    download: { mode: "bytes" },
  };
  workspace.assistantArtifacts = {
    items: options.files ? [artifact] : [],
    resolved: true,
    loaded: true,
    loading: false,
    error: null,
  };
  let board = boardFixture(state.sessionKey, options.loaded);
  let acquired = options.acquired ?? true;
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
  let binding = createDetailsOutputsBinding(context, state, workspace, board.provider, acquired);
  const read = () => projectDetailsOutputs(binding, workspace, readBoard()).outputs!;
  const openArtifact = vi.fn();
  const [outputs, setOutputs] = createSignal<ChatDetailsOutputs>({
    ...read(),
    onOpenArtifact: openArtifact,
  });
  const draw = () => {
    setOutputs({ ...read(), onOpenArtifact: openArtifact });
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
    request,
    openArtifact,
    openDashboard,
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
      acquired = true;
      binding = createDetailsOutputsBinding(context, state, workspace, board.provider, acquired);
      draw();
    },
    replace() {
      const previous = board;
      binding.stop();
      board = boardFixture(state.sessionKey, true);
      board.resolve(true);
      binding = createDetailsOutputsBinding(context, state, workspace, board.provider, true);
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
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Loading dashboard"),
  );
  expect(view.queryByText("No outputs yet")).toBeNull();
  view.acquire();
  await waitForSolid(() => expect(view.queryByText("Loading dashboard…")).toBeNull());
  expect(view.container.textContent).toContain("No outputs yet");
});

it.each([false, true])(
  "keeps files usable through dashboard failure and owner recovery (desktop=%s)",
  async (desktop) => {
    const view = mountOutputs({ desktop, files: true });
    await waitForSolid(() => expect(view.getByRole("button", { name: "Report.txt" })).toBeTruthy());
    view.getByRole("button", { name: "Report.txt" }).click();
    expect(view.openArtifact).toHaveBeenCalledWith("report");
    view.fail();
    await waitForSolid(() =>
      expect(view.getByRole("status").textContent).toContain("Dashboard request failed"),
    );
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.getByRole("button", { name: "Report.txt" })).toBeTruthy();
    view.resolve(true);
    await waitForSolid(() => expect(view.queryByRole("status")).toBeNull());
    view.getByRole("button", { name: "Overview" }).click();
    expect(view.openDashboard).toHaveBeenCalledOnce();
    expect(view.request.mock.calls.filter(([method]) => method === "board.get")).toHaveLength(0);
  },
);

it("keeps dashboard readiness alive when Files demand is released and retires pending providers", async () => {
  const view = mountOutputs();
  view.retainAndReleaseFiles();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Loading dashboard"),
  );
  const previous = view.replace();
  await waitForSolid(() => expect(view.getByRole("button", { name: "Overview" })).toBeTruthy());
  previous.fail();
  previous.resolve();
  await waitForSolid(() => expect(view.queryByRole("status")).toBeNull());
  expect(view.getByRole("button", { name: "Overview" })).toBeTruthy();
});
