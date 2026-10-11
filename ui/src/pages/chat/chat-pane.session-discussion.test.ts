/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.tsx";
import "./components/session-discussion-panel.tsx";
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
  paneWidth: number;
};

const SESSION_KEY = "agent:main:current";

function createDiscussionPane(params: {
  info: SessionDiscussionInfo | Promise<SessionDiscussionInfo>;
  detailOpen?: boolean;
  scopes?: string[];
}) {
  const request = vi.fn().mockImplementation(async (method: string) => {
    if (method === "session.discussion.info") {
      return await params.info;
    }
    throw new Error(`unexpected method ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const created = createTestChatPane({ client, sessions: createSessionCapabilityFixture() });
  const pane = created.pane as DiscussionTestPane;
  const state = created.state;
  (pane.context.gateway.snapshot as { hello: unknown }).hello = {
    auth: { role: "operator", scopes: params.scopes ?? ["operator.read", "operator.write"] },
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
  it("does not probe an advertised discussion method without its read scope", async () => {
    const { pane, request } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
      scopes: ["operator.sessions.read", "operator.sessions.write"],
    });
    await pane.probeSessionDiscussion(SESSION_KEY);
    expect(request).not.toHaveBeenCalled();
    expect(pane.resolveSessionDiscussionAction()).toBeNull();
  });

  it("does not reload discussion info when the pane renders unchanged config twice", async () => {
    const { pane, state, request } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
    });
    const container = document.createElement("div");
    document.body.append(container);

    const renderPanel = async () => {
      const config = pane.buildSessionDiscussionPanel(state, SESSION_KEY)!;
      render(
        html`<openclaw-session-discussion
          .sessionKey=${config.sessionKey}
          .canOpen=${config.canOpen}
          .sourceGeneration=${pane.connectionGeneration}
          .loadInfo=${config.loadInfo}
          .openDiscussion=${config.openDiscussion}
          .onStateChange=${config.onStateChange}
        ></openclaw-session-discussion>`,
        container,
      );
      await container.querySelector("openclaw-session-discussion")?.updateComplete;
    };

    await renderPanel();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await renderPanel();
    expect(request).toHaveBeenCalledTimes(1);

    container.remove();
  });

  it("uses the header action to open and close the discussion slot", async () => {
    const { pane, state, updateSidebarLayout } = createDiscussionPane({
      info: { state: "available" },
    });
    await pane.probeSessionDiscussion(SESSION_KEY);
    let action = pane.resolveSessionDiscussionAction();
    expect(action?.label).toBe("Show discussion");
    expect(action?.active).toBe(false);
    action?.onToggle();
    expect(updateSidebarLayout).toHaveBeenCalledTimes(1);

    action = pane.resolveSessionDiscussionAction();
    expect(action?.label).toBe("Hide discussion");
    expect(action?.active).toBe(true);
    action?.onToggle();
    expect(state.sidebarLayout.columns[0]?.panels).toEqual([]);
    expect(state.sidebarLayout.open).toBe(false);
    expect(updateSidebarLayout).toHaveBeenCalledTimes(2);
  });

  it("opens as a collapsed tab when two columns cannot fit side by side", async () => {
    const { pane, state } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
      detailOpen: true,
    });
    pane.paneWidth = 700;
    await pane.probeSessionDiscussion(SESSION_KEY);
    pane.resolveSessionDiscussionAction()?.onToggle();

    expect(
      state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
    ).toEqual(["detail", "discussion"]);
  });

  it("ignores a stale none callback after switching sessions", async () => {
    const { pane, state } = createDiscussionPane({
      info: { state: "open", embedUrl: "https://clack.example/embed/c1" },
    });
    await pane.probeSessionDiscussion(SESSION_KEY);
    const stalePanel = pane.buildSessionDiscussionPanel(state, SESSION_KEY);
    state.sessionKey = "agent:main:other";
    state.sidebarLayout = openSlot({ columns: [] }, "discussion");

    stalePanel?.onStateChange(SESSION_KEY, "none", null);

    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("discussion");
  });

  it("does not load a saved visible Discussion tab after reconnect without operator.read", async () => {
    const openUrl = "https://clack.example/channels/previous";
    const { pane, state, request } = createDiscussionPane({
      info: { state: "open", openUrl },
    });
    const initialHello = pane.context.gateway.snapshot.hello!;
    state.sidebarLayout = openSlot({ columns: [] }, "discussion");
    const container = document.createElement("div");
    document.body.append(container);

    const renderSavedTab = async () => {
      const config = pane.buildSessionDiscussionPanel(state, SESSION_KEY);
      render(
        html`<section data-panel-slot="discussion">
          ${
            config
              ? html`<openclaw-session-discussion
                  .sessionKey=${config.sessionKey}
                  .canOpen=${config.canOpen}
                  .sourceGeneration=${pane.connectionGeneration}
                  .loadInfo=${config.loadInfo}
                  .openDiscussion=${config.openDiscussion}
                  .onStateChange=${config.onStateChange}
                ></openclaw-session-discussion>`
              : nothing
          }
        </section>`,
        container,
      );
      await container.querySelector("openclaw-session-discussion")?.updateComplete;
    };
    const discussionRequests = () =>
      request.mock.calls.filter(([method]) => method === "session.discussion.info");

    const previousConfig = pane.buildSessionDiscussionPanel(state, SESSION_KEY)!;
    await renderSavedTab();
    await vi.waitFor(() => expect(discussionRequests()).toHaveLength(1));
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLAnchorElement>("a.session-link")?.href).toBe(openUrl),
    );

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await renderSavedTab();
    // The fixture only supplies Discussion RPCs; unrelated chat startup is already settled.
    pane.connectedClient = state.client;
    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "connected",
      hello: {
        ...initialHello,
        auth: {
          role: "operator",
          scopes: ["operator.sessions.read", "operator.sessions.write"],
        },
        features: { methods: ["session.discussion.info", "session.discussion.open"] },
      },
    });
    await renderSavedTab();
    await expect(previousConfig.loadInfo(SESSION_KEY)).rejects.toThrow();

    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("discussion");
    expect(container.querySelector('[data-panel-slot="discussion"]')).not.toBeNull();
    expect(discussionRequests()).toHaveLength(1);
    expect(container.querySelector("openclaw-session-discussion")).toBeNull();
    expect(container.querySelector("a.session-link")).toBeNull();
    expect(container.querySelector(".callout.danger")).toBeNull();
    expect(pane.resolveSessionDiscussionAction()).toBeNull();

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    pane.connectedClient = state.client;
    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "connected",
      hello: {
        ...initialHello,
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["session.discussion.info", "session.discussion.open"] },
      },
    });
    await renderSavedTab();
    await vi.waitFor(() => expect(discussionRequests()).toHaveLength(2));
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLAnchorElement>("a.session-link")?.href).toBe(openUrl),
    );

    container.remove();
  });
});
