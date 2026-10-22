import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { t } from "../../../i18n/index.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import {
  createSubscriptionHydrationHarness,
  sessionsResult,
} from "../../sessions/session-capability.test-support.ts";
import "./session-progress.tsx";

function createContext() {
  const { gateway, sessions, selection, connect } = createSubscriptionHydrationHarness(
    async (method) => {
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      if (method === "progressCard.get") {
        return { card: null };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
  );
  connect();
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
    subscriptions: () => [active, subscribe.mock.calls.length],
  };
}

function mount(context: ApplicationContext) {
  const provider = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-session-progress-widget");
  element.session = { sessionKey: "agent:main:progress-widget" };
  provider.append(element);
  document.body.append(provider);
  return { provider, element };
}

async function ready(element: HTMLElementTagNameMap["openclaw-session-progress-widget"]) {
  await element.updateComplete;
  await vi.waitFor(() =>
    expect(element.textContent).toContain(t("sessionProgressCard.widgetEmpty")),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("does not reacquire a roster listener when a queued property update runs after removal", async () => {
  const owner = createContext();
  const { provider, element } = mount(owner.context);

  for (let connections = 1; connections <= 2; connections += 1) {
    await ready(element);
    expect(owner.subscriptions()).toEqual([1, connections]);

    element.session = { sessionKey: `agent:main:queued-${connections}` };
    const update = element.updateComplete;
    element.remove();
    await update;
    expect(element.isConnected).toBe(false);
    expect(owner.subscriptions()).toEqual([0, connections]);

    if (connections === 1) {
      provider.append(element);
    }
  }
});

it("moves the listener with context and activity without duplicating it on selection changes", async () => {
  const first = createContext();
  const second = createContext();
  const { provider, element } = mount(first.context);
  await ready(element);
  const subscriptions = () => [...first.subscriptions(), ...second.subscriptions()];
  expect(subscriptions()).toEqual([1, 1, 0, 0]);
  const selectBoth = () => [first.selection.set("main"), second.selection.set("writer")];
  const transitions: [() => unknown, number, number, number, number][] = [
    [() => first.selection.set("writer"), 1, 1, 0, 0],
    [() => provider.setContext(second.context), 0, 1, 1, 1],
    [selectBoth, 0, 1, 1, 1],
    [() => Object.assign(element, { active: false }), 0, 1, 0, 1],
    [() => Object.assign(element, { active: true }), 0, 1, 1, 2],
    [() => element.remove(), 0, 1, 0, 2],
  ];
  for (const [act, ...expected] of transitions) {
    act();
    await element.updateComplete;
    expect(subscriptions()).toEqual(expected);
  }
});
