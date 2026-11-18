/* @vitest-environment jsdom */

import { createMemo, createSignal, Show } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { buildChatDiscussionPanel } from "./chat-pane-discussion-panel.ts";
import type { ChatDiscussionPanelSource } from "./chat-pane-panel-source.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";
import {
  SessionDiscussionPanel,
  type SessionDiscussionPanelConfig,
} from "./components/session-discussion-panel.tsx";
import { openSlot } from "./sidebar-layout.ts";

type DiscussionTestPane = TestChatPane & {
  sessionDiscussionSource: (
    state: ReturnType<typeof createTestChatPane>["state"],
    sessionKey: string,
  ) => ChatDiscussionPanelSource | null;
  probeSessionDiscussion: (sessionKey: string) => Promise<void>;
  resolveSessionDiscussionAction: () => {
    label: string;
    active: boolean;
    onToggle: () => void;
  } | null;
  paneWidth: number;
};

const SESSION_KEY = "agent:main:current";

function buildDiscussionPanel(pane: DiscussionTestPane, state: DiscussionTestPane["state"]) {
  const source = pane.sessionDiscussionSource(state, SESSION_KEY);
  return source ? buildChatDiscussionPanel(source) : null;
}

function createDiscussionPanelHarness(
  fixture: ReturnType<typeof createDiscussionPane>,
  savedSlot = false,
) {
  const { pane, state } = fixture;
  const container = document.body.appendChild(document.createElement("div"));
  const [frame, setFrame] = createSignal<{
    config: SessionDiscussionPanelConfig | null;
    sourceGeneration: number;
  }>({ config: null, sourceGeneration: 0 });
  const panel = () => (
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
  );
  const view = mountSolid(
    () => (savedSlot ? <section data-panel-slot="discussion">{panel()}</section> : panel()),
    { container },
  );
  return {
    container,
    async render() {
      setFrame({
        config: buildDiscussionPanel(pane, state),
        sourceGeneration: pane.connectionGeneration,
      });
      flush();
      await container.querySelector("openclaw-session-discussion")?.updateComplete;
    },
    unmount() {
      view.unmount();
      container.remove();
    },
  };
}

function createDiscussionPane(
  params: {
    info?: SessionDiscussionInfo | Promise<SessionDiscussionInfo>;
    detailOpen?: boolean;
  } = {},
) {
  const request = vi.fn().mockImplementation(async (method: string) => {
    if (method === "session.discussion.info") {
      return await (params.info ?? { state: "open", embedUrl: "https://clack.example/embed/c1" });
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
  state.sidebarLayout = params.detailOpen ? openSlot({ columns: [] }, "detail") : { columns: [] };
  const updateSidebarLayout = vi.fn((layout) => {
    state.sidebarLayout = layout;
  });
  state.updateSidebarLayout = updateSidebarLayout;
  return { pane, state, updateSidebarLayout, request };
}

describe("chat pane session discussion", () => {
  it("publishes discussion availability and its external URL while retaining the panel", async () => {
    const openUrl = "https://clack.example/channels/c1";
    const { pane, state, updateSidebarLayout } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1", openUrl },
    });

    const panel = buildDiscussionPanel(pane, state);
    const view = mountSolid(() => {
      const discussion = projectOwner(pane.sessionDiscussion, (owner) => owner.snapshot);
      const frame = createMemo(() => {
        discussion.read();
        return {
          action: pane.resolveSessionDiscussionAction(),
          panel: buildDiscussionPanel(pane, state),
        };
      });
      return (
        <>
          <span>{frame().action?.label}</span>
          <a href={frame().panel?.openUrl ?? undefined}>Discussion</a>
        </>
      );
    });
    expect(view.container.querySelector("span")?.textContent).toBe("");
    await pane.probeSessionDiscussion(SESSION_KEY);
    flush();
    expect(view.container.querySelector("span")?.textContent).toBe("Show discussion");
    expect(updateSidebarLayout).not.toHaveBeenCalled();

    panel?.onStateChange(SESSION_KEY, "open", openUrl);
    expect(buildDiscussionPanel(pane, state)).toBe(panel);
    flush();
    expect(view.container.querySelector("a")?.href).toBe(openUrl);
    view.unmount();
  });

  it("uses the header action to open and close the discussion slot", async () => {
    const { pane, state, updateSidebarLayout } = createDiscussionPane({
      info: { state: "available" },
    });
    await pane.probeSessionDiscussion(SESSION_KEY);
    let action = pane.resolveSessionDiscussionAction();
    expect(action).toMatchObject({ label: "Show discussion", active: false });
    action?.onToggle();
    expect(updateSidebarLayout).toHaveBeenCalledTimes(1);

    action = pane.resolveSessionDiscussionAction();
    expect(action).toMatchObject({ label: "Hide discussion", active: true });
    action?.onToggle();
    expect(state.sidebarLayout.columns[0]?.panels).toEqual([]);
    expect(state.sidebarLayout.open).toBe(false);
    expect(updateSidebarLayout).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 700])(
    "preserves the detail slot when opening discussion at width %s",
    async (width) => {
      const { pane, state } = createDiscussionPane({ detailOpen: true });
      if (width !== undefined) {
        pane.paneWidth = width;
      }
      await pane.probeSessionDiscussion(SESSION_KEY);
      pane.resolveSessionDiscussionAction()?.onToggle();
      expect(
        state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
      ).toEqual(["detail", "discussion"]);
    },
  );

  it("ignores a stale none callback after switching sessions", async () => {
    const { pane, state } = createDiscussionPane();
    await pane.probeSessionDiscussion(SESSION_KEY);
    const stalePanel = buildDiscussionPanel(pane, state);
    state.sessionKey = "agent:main:other";
    state.sidebarLayout = openSlot({ columns: [] }, "discussion");

    stalePanel?.onStateChange(SESSION_KEY, "none", null);

    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("discussion");
  });

  it("does not load a saved visible Discussion tab after reconnect without operator.read", async () => {
    const openUrl = "https://clack.example/channels/previous";
    const fixture = createDiscussionPane({ info: { state: "open", openUrl } });
    const { pane, state, request } = fixture;
    const initialHello = pane.context.gateway.snapshot.hello!;
    state.sidebarLayout = openSlot({ columns: [] }, "discussion");
    const view = createDiscussionPanelHarness(fixture, true);
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

    const previousConfig = buildDiscussionPanel(pane, state)!;
    await view.render();
    await vi.waitFor(() => expect(discussionRequests()).toHaveLength(1));
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLAnchorElement>("a.session-link")?.href).toBe(openUrl),
    );
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
    expect(container.querySelector("openclaw-session-discussion")).toBeNull();
    expect(container.querySelector("a.session-link")).toBeNull();
    expect(container.querySelector(".callout.danger")).toBeNull();
    expect(pane.resolveSessionDiscussionAction()).toBeNull();

    disconnect();
    connect(["operator.read"]);
    await view.render();
    await vi.waitFor(() => expect(discussionRequests()).toHaveLength(2));
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLAnchorElement>("a.session-link")?.href).toBe(openUrl),
    );

    view.unmount();
  });
});
