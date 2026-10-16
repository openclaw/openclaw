/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import {
  connectPaneTestView,
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";

it("parks and remounts presentation subscriptions using the runtime's context without a provider", async () => {
  const { pane } = createTestChatPane({
    client: createGatewayBrowserClientFixture(),
    sessions: createSessionCapabilityFixture(),
  });
  const navigation = pane.context.navigation;
  const subscribe = navigation.subscribe.bind(navigation);
  const released = vi.fn();
  const subscriptions = vi.spyOn(navigation, "subscribe").mockImplementation((listener) => {
    const stop = subscribe(listener);
    return () => {
      released();
      stop();
    };
  });
  const pluginSubscriptions = vi.spyOn(pane.context.plugins, "subscribe");
  const rendered: boolean[] = [];
  const render = vi.fn(() => {
    rendered.push(navigation.snapshot.navCollapsed);
    return { layout: null, capabilityDialogs: undefined, providerReviewSource: undefined };
  });
  pane.render = render;
  onTestFinished(() => {
    pane.disconnectedCallback();
    vi.restoreAllMocks();
  });
  connectPaneTestView(pane);
  await pane.updateComplete;
  expect(subscriptions).toHaveBeenCalledOnce();
  expect(pluginSubscriptions).toHaveBeenCalledOnce();

  navigation.update({ navCollapsed: true });
  await waitForSolid(() => expect(rendered.at(-1)).toBe(true));
  pane.presented = false;
  await Promise.resolve();
  flush();
  render.mockClear();
  navigation.update({ navCollapsed: false });
  await Promise.resolve();
  flush();
  expect(render).not.toHaveBeenCalled();
  pane.presented = true;
  await pane.updateComplete;
  expect(rendered.at(-1)).toBe(false);

  pane.disconnectedCallback();
  expect(released).toHaveBeenCalledTimes(subscriptions.mock.calls.length);
  const acquired = subscriptions.mock.calls.length;
  render.mockClear();
  navigation.update({ navCollapsed: true });
  pane.requestUpdate();
  await Promise.resolve();
  flush();
  expect(render).not.toHaveBeenCalled();
  expect(subscriptions).toHaveBeenCalledTimes(acquired);

  connectPaneTestView(pane);
  await pane.updateComplete;
  expect(subscriptions).toHaveBeenCalledTimes(acquired + 1);
  expect(rendered.at(-1)).toBe(true);
});

it("retires auth presentation once per event and releases the Gateway listener on disconnect", async () => {
  const key = "agent:main:subscription-auth";
  const authStatus = { ts: 43, providers: [] };
  const fixture = createMountedPanes(
    [{ key, agentId: "main", kind: "direct", sessionId: "subscription-auth", updatedAt: 1 }],
    "main",
    undefined,
    { "models.authStatus": () => authStatus },
  );
  const pane = fixture.mount(key);
  const ready = async () => {
    await pane.updateComplete;
    await waitForSolid(() => {
      expect(pane.state.connected).toBe(true);
      expect(pane.state.chatLoading).toBe(false);
    });
  };
  await ready();

  for (let connection = 0; connection < 2; connection += 1) {
    const state = pane.state;
    const previous = { ts: 42, providers: [] };
    state.modelAuthStatusResult = previous;
    const version = state.modelAuthStatusRequestVersion;
    fixture.emitGatewayEvent("chat.metadata.changed", { authChanged: false });
    expect(state.modelAuthStatusResult).toBe(previous);
    expect(state.modelAuthStatusRequestVersion).toBe(version);

    fixture.emitGatewayEvent("chat.metadata.changed", { authChanged: true });
    expect(state.modelAuthStatusResult).toBeNull();
    expect(state.modelAuthStatusRequestVersion).toBe(version + 1);
    await waitForSolid(() => expect(state.modelAuthStatusResult).toEqual(authStatus));
    const settled = expectDefined(state.modelAuthStatusResult, "settled auth presentation");
    const settledVersion = state.modelAuthStatusRequestVersion;
    pane.disconnectedCallback();
    fixture.emitGatewayEvent("chat.metadata.changed", { authChanged: true });
    expect(state.modelAuthStatusResult).toBe(settled);
    expect(state.modelAuthStatusRequestVersion).toBe(settledVersion);
    if (connection === 0) {
      pane.connectedCallback();
      await ready();
    }
  }
});
