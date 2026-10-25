/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionDiscussionInfo } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.tsx";
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

  it("revokes saved Discussion access on reconnect and rejects captured callbacks", async () => {
    const openUrl = "https://clack.example/channels/previous";
    const { pane, state, request } = createDiscussionPane({ state: "open", openUrl });
    const initialHello = pane.context.gateway.snapshot.hello!;
    state.sidebarLayout = openSlot({ columns: [] }, "discussion");
    const reconnect = (scopes: string[]) => {
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        phase: "reconnecting",
        hello: null,
      });
      // Chat startup is settled; this fixture owns only the Discussion RPCs.
      pane.connectedClient = state.client;
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        phase: "connected",
        hello: { ...initialHello, auth: { role: "operator", scopes } },
      });
    };
    const previous = pane.buildSessionDiscussionPanel(state, SESSION_KEY)!;
    await expect(previous.loadInfo(SESSION_KEY)).resolves.toMatchObject({ openUrl });
    const requestsBeforeRevocation = request.mock.calls.length;
    reconnect(["operator.sessions.read", "operator.sessions.write"]);
    await pane.probeSessionDiscussion(SESSION_KEY);
    await expect(previous.loadInfo(SESSION_KEY)).rejects.toThrow();
    expect(pane.buildSessionDiscussionPanel(state, SESSION_KEY)).toBeNull();
    expect(pane.resolveSessionDiscussionAction()).toBeNull();
    expect(state.sidebarLayout.columns[0]?.panels[0]?.slot).toBe("discussion");
    expect(request).toHaveBeenCalledTimes(requestsBeforeRevocation);
    reconnect(["operator.read"]);
    const restored = pane.buildSessionDiscussionPanel(state, SESSION_KEY)!;
    await expect(restored.loadInfo(SESSION_KEY)).resolves.toMatchObject({ openUrl });
  });
});
