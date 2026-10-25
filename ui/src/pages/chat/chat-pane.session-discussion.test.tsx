/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import {
  SessionDiscussionPanel,
  type SessionDiscussionPanelConfig,
} from "./components/session-discussion-panel.tsx";
import { openSlot } from "./sidebar-layout.ts";

type DiscussionTestPane = TestChatPane & {
  buildSessionDiscussionPanel: (
    state: ReturnType<typeof createTestChatPane>["state"],
    sessionKey: string,
  ) => SessionDiscussionPanelConfig | null;
  probeSessionDiscussion: (sessionKey: string) => Promise<void>;
  resolveSessionDiscussionAction: () => {
    label: string;
    active: boolean;
    onToggle: () => void;
  } | null;
};

const SESSION_KEY = "agent:main:current";

function createDiscussionPanelHarness({ pane, state }: ReturnType<typeof createDiscussionPane>) {
  const [frame, setFrame] = createSignal<{
    config: SessionDiscussionPanelConfig | null;
    sourceGeneration: number;
  }>({ config: null, sourceGeneration: 0 });
  const view = mountSolid(() => (
    <section data-panel-slot="discussion">
      <Show when={frame().config}>
        {(config) => (
          <SessionDiscussionPanel
            sessionKey={config().sessionKey}
            canOpen={config().canOpen}
            sourceGeneration={frame().sourceGeneration}
            loadInfo={config().loadInfo}
            openDiscussion={config().openDiscussion}
            onStateChange={config().onStateChange}
          />
        )}
      </Show>
    </section>
  ));
  return {
    ...view,
    async render() {
      setFrame({
        config: pane.buildSessionDiscussionPanel(state, SESSION_KEY),
        sourceGeneration: pane.connectionGeneration,
      });
      flush();
      await view.container.querySelector("openclaw-session-discussion")?.updateComplete;
    },
  };
}

function createDiscussionPane(info: SessionDiscussionInfo = { state: "available" }) {
  const request = vi.fn().mockImplementation(async (method: string) => {
    if (method === "session.discussion.info") {
      return info;
    }
    throw new Error(`unexpected method ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const created = createTestChatPane({ client, sessions: createSessionCapabilityFixture() });
  const pane = created.pane as DiscussionTestPane;
  const state = created.state;
  (pane.context.gateway.snapshot as { hello: unknown }).hello = {
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    features: { methods: ["session.discussion.info", "session.discussion.open"] },
  };
  state.sidebarLayout = { columns: [] };
  const updateSidebarLayout = vi.fn((layout) => {
    state.sidebarLayout = layout;
  });
  state.updateSidebarLayout = updateSidebarLayout;
  return { pane, state, updateSidebarLayout, request };
}

describe("chat pane session discussion", () => {
  it("publishes discussion availability and its external URL while retaining the panel", async () => {
    const openUrl = "https://clack.example/channels/c1";
    const { pane, state, updateSidebarLayout } = createDiscussionPane({ state: "open", openUrl });
    const panel = pane.buildSessionDiscussionPanel(state, SESSION_KEY);
    const published = vi.fn();
    onTestFinished(pane.sessionDiscussion.subscribe(published));
    expect(pane.resolveSessionDiscussionAction()).toBeNull();
    await pane.probeSessionDiscussion(SESSION_KEY);
    expect(pane.resolveSessionDiscussionAction()?.label).toBe("Show discussion");
    expect(updateSidebarLayout).not.toHaveBeenCalled();
    panel?.onStateChange(SESSION_KEY, "open", openUrl);
    expect(pane.buildSessionDiscussionPanel(state, SESSION_KEY)?.openUrl).toBe(openUrl);
    expect(published).toHaveBeenCalledTimes(2);
  });

  it("toggles Discussion without replacing the existing detail slot", async () => {
    const { pane, state } = createDiscussionPane();
    state.sidebarLayout = openSlot({ columns: [] }, "detail");
    await pane.probeSessionDiscussion(SESSION_KEY);
    let action = pane.resolveSessionDiscussionAction();
    expect(action).toMatchObject({ label: "Show discussion", active: false });
    action?.onToggle();
    expect(
      state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
    ).toEqual(["detail", "discussion"]);

    action = pane.resolveSessionDiscussionAction();
    expect(action).toMatchObject({ label: "Hide discussion", active: true });
    action?.onToggle();
    expect(state.sidebarLayout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["detail"]);
  });

  it("ignores a stale none callback after switching sessions", async () => {
    const { pane, state } = createDiscussionPane();
    await pane.probeSessionDiscussion(SESSION_KEY);
    const stalePanel = pane.buildSessionDiscussionPanel(state, SESSION_KEY);
    state.sessionKey = "agent:main:other";
    state.sidebarLayout = openSlot({ columns: [] }, "discussion");

    stalePanel?.onStateChange(SESSION_KEY, "none", null);

    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("discussion");
  });

  it("does not load a saved visible Discussion tab after reconnect without operator.read", async () => {
    const openUrl = "https://clack.example/channels/previous";
    const fixture = createDiscussionPane({ state: "open", openUrl });
    const { pane, state, request } = fixture;
    const initialHello = pane.context.gateway.snapshot.hello!;
    state.sidebarLayout = openSlot({ columns: [] }, "discussion");
    const view = createDiscussionPanelHarness(fixture);
    const { container } = view;
    const disconnect = () =>
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        phase: "reconnecting",
        hello: null,
      });
    const connect = (scopes: string[]) => {
      // The fixture supplies only Discussion RPCs; chat startup is already settled.
      pane.connectedClient = state.client;
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        phase: "connected",
        hello: { ...initialHello, auth: { role: "operator", scopes } },
      });
    };
    const discussionRequests = () =>
      request.mock.calls.filter(([method]) => method === "session.discussion.info");
    const expectLoaded = async (requests: number) => {
      await vi.waitFor(() => expect(discussionRequests()).toHaveLength(requests));
      await vi.waitFor(() =>
        expect(container.querySelector<HTMLAnchorElement>("a.session-link")?.href).toBe(openUrl),
      );
    };

    const previousConfig = pane.buildSessionDiscussionPanel(state, SESSION_KEY)!;
    await view.render();
    await expectLoaded(1);
    await view.render();
    expect(discussionRequests()).toHaveLength(1);

    disconnect();
    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("discussion");
    await view.render();
    connect(["operator.sessions.read", "operator.sessions.write"]);
    await view.render();
    await pane.probeSessionDiscussion(SESSION_KEY);
    await expect(previousConfig.loadInfo(SESSION_KEY)).rejects.toThrow();

    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("discussion");
    expect(container.querySelector('[data-panel-slot="discussion"]')).not.toBeNull();
    expect(discussionRequests()).toHaveLength(1);
    expect(
      container.querySelector("openclaw-session-discussion,a.session-link,.callout.danger"),
    ).toBeNull();
    expect(pane.resolveSessionDiscussionAction()).toBeNull();

    disconnect();
    connect(["operator.read"]);
    await view.render();
    await expectLoaded(2);

    view.unmount();
  });
});
