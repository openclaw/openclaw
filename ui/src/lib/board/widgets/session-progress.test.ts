import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createAgentSelectionCapability } from "../../../app/agent-selection.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { t } from "../../../i18n/index.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../sessions/session-capability.test-support.ts";
import "./session-progress.ts";

function createContext() {
  const { gateway } = createGatewayHarness(
    createTestGatewayClient(async (method) => {
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      if (method === "progressCard.get") {
        return { card: null };
      }
      throw new Error(`Unexpected request: ${method}`);
    }),
  );
  const sessions = createTestSessionCapability(gateway);
  const selection = createAgentSelectionCapability(
    Object.assign(gateway, { connection: { gatewayUrl: "ws://gateway.example.test" } }),
    { state: { agentsList: null }, subscribe: () => () => undefined },
  );
  let active = 0;
  const subscribeList = sessions.subscribeList.bind(sessions);
  const subscribe = vi.spyOn(sessions, "subscribeList").mockImplementation((scope, listener) => {
    const release = subscribeList(scope, listener);
    active += 1;
    return () => {
      release();
      active -= 1;
    };
  });
  onTestFinished(() => {
    sessions.dispose();
    selection.dispose();
  });
  return {
    context: { gateway, sessions, agentSelection: selection } as unknown as ApplicationContext,
    selection,
    subscribe,
    active: () => active,
  };
}

function mount(context: ApplicationContext) {
  const provider = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-session-progress-widget");
  element.session = { sessionKey: "agent:main:progress-widget" };
  provider.append(element);
  document.body.append(provider);
  onTestFinished(() => provider.remove());
  return { provider, element };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Session progress widget subscriptions", () => {
  it("does not reacquire a roster listener when a queued property update runs after removal", async () => {
    const owner = createContext();
    const { provider, element } = mount(owner.context);

    for (let connections = 1; connections <= 2; connections += 1) {
      await element.updateComplete;
      await vi.waitFor(() =>
        expect(element.textContent).toContain(t("sessionProgressCard.widgetEmpty")),
      );
      expect(owner.active()).toBe(1);
      expect(owner.subscribe).toHaveBeenCalledTimes(connections);

      element.session = { sessionKey: `agent:main:queued-${connections}` };
      const update = element.updateComplete;
      expect(element.isUpdatePending).toBe(true);
      element.remove();
      expect(owner.active()).toBe(0);
      await update;
      expect(element.isConnected).toBe(false);
      expect(owner.active()).toBe(0);
      expect(owner.subscribe).toHaveBeenCalledTimes(connections);

      if (connections === 1) {
        provider.append(element);
      }
    }
  });

  it("moves the listener with context and activity without duplicating it on selection changes", async () => {
    const first = createContext();
    const second = createContext();
    const { provider, element } = mount(first.context);
    await element.updateComplete;
    await vi.waitFor(() =>
      expect(element.textContent).toContain(t("sessionProgressCard.widgetEmpty")),
    );
    expect([first.active(), second.active()]).toEqual([1, 0]);

    first.selection.set("writer");
    await element.updateComplete;
    expect(first.subscribe).toHaveBeenCalledOnce();

    provider.setContext(second.context);
    await element.updateComplete;
    expect([first.active(), second.active()]).toEqual([0, 1]);
    first.selection.set("main");
    second.selection.set("writer");
    await element.updateComplete;
    expect(second.subscribe).toHaveBeenCalledOnce();

    element.active = false;
    await element.updateComplete;
    expect([first.active(), second.active()]).toEqual([0, 0]);
    element.active = true;
    await element.updateComplete;
    expect([first.active(), second.active()]).toEqual([0, 1]);
    element.remove();
    await element.updateComplete;
    expect([first.active(), second.active()]).toEqual([0, 0]);
  });
});
