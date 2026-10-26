/* @vitest-environment jsdom */

import type { BoardGetParams, BoardWidget } from "@openclaw/gateway-protocol";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiViewContext } from "../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventListener } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { acquireBoardProviderForSession } from "../lib/board/provider.ts";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createInertViewHost } from "./control-ui-view.test-support.ts";
import "./control-ui-dashboard.tsx";
import "./control-ui-contributions.solid.tsx";

type DashboardElement = HTMLElementTagNameMap["openclaw-plugin-session-dashboard"];
const toggle = (element: DashboardElement) =>
  element.querySelector<HTMLButtonElement>(".plugin-session-dashboard__toggle")!;
const expanded = (element: DashboardElement) => toggle(element).getAttribute("aria-expanded");
const nativeOwner = (element: DashboardElement) =>
  element.querySelector('[data-native-owner="widget"]');
const emptyLabel = (element: DashboardElement) =>
  element.querySelector(".plugin-session-dashboard__collapsed-empty");
const tab = (element: DashboardElement, id: string) =>
  element.querySelector<HTMLButtonElement>(`[role="tab"][data-board-tab-id="${id}"]`)!;
const boardTabs = () =>
  ["main", "research"].map((tabId, position) => ({
    tabId,
    title: position ? "Research" : "Main",
    position,
    chatDock: "right",
  }));
const snapshot = (
  sessionKey: string,
  widgets: BoardWidget[] = [],
  tabs = widgets.length ? boardTabs().slice(0, 1) : [],
) => ({ sessionKey, revision: 1, tabs, widgets });

async function settle(element: DashboardElement) {
  await element.updateComplete;
  await element.querySelector("openclaw-board-view")?.updateComplete;
}

async function selectSession(element: DashboardElement, sessionKey: string | null) {
  element.session = sessionKey === null ? null : { sessionKey };
  await element.updateComplete;
}

async function boardView(element: DashboardElement) {
  await vi.waitFor(() => expect(element.querySelector("openclaw-board-view")).not.toBeNull());
  return element.querySelector("openclaw-board-view")!;
}

async function setPermissions(element: DashboardElement, value: boolean) {
  element.canMutate = element.canGrant = value;
  await settle(element);
  const board = element.querySelector("openclaw-board-view")!;
  await board.querySelector("openclaw-board-widget-cell")?.updateComplete;
  expect([board.canMutate, board.canGrant]).toEqual([value, value]);
}

function widget(overrides: Partial<BoardWidget> = {}): BoardWidget {
  return createBoardWidget({
    name: "status",
    title: "Status",
    sizeW: 12,
    sizeH: 2,
    ...overrides,
  });
}

function createClient(widgets: BoardWidget[] = [], load?: (params?: BoardGetParams) => unknown) {
  let listener: GatewayEventListener | undefined;
  const removeListener = vi.fn(() => {
    listener = undefined;
  });
  const request = vi.fn(async (_method: string, params?: BoardGetParams) => {
    if (load) {
      return load(params);
    }
    const key = params?.sessionKey ?? "agent:main:unknown";
    return snapshot(key === "global" ? `agent:${params?.agentId}:global` : key, widgets);
  });
  return {
    client: {
      request,
      addEventListener: vi.fn((next: GatewayEventListener) => {
        listener = next;
        return removeListener;
      }),
    } as unknown as GatewayBrowserClient,
    request,
    removeListener,
    changed: (sessionKey: string, revision: number) =>
      listener?.({ type: "event", event: "board.changed", payload: { sessionKey, revision } }),
  };
}

async function mountDashboard(
  session: BoardGetParams,
  client: GatewayBrowserClient,
  capabilities: { canMutate?: boolean; canGrant?: boolean } = {},
  container: HTMLElement = document.body,
): Promise<DashboardElement> {
  const element = document.createElement("openclaw-plugin-session-dashboard");
  element.session = session;
  element.client = client;
  element.connected = true;
  element.canMutate = capabilities.canMutate ?? false;
  element.canGrant = capabilities.canGrant ?? false;
  container.append(element);
  onTestFinished(async () => {
    element.remove();
    await Promise.resolve();
  });
  await element.updateComplete;
  return element;
}

it.each([
  { sessionKey: "global", hydrateOwner: false },
  { sessionKey: "agent:writer:workboard-owner-hydration", hydrateOwner: true },
])(
  "passes the queried owner of $sessionKey to native widgets outside the selected agent",
  async ({ sessionKey, hydrateOwner }) => {
    const widgetSignals: AbortSignal[] = [];
    const signal = new AbortController().signal;
    const host = createInertViewHost(signal);
    const entry = {
      key: "identity/context",
      pluginId: "identity",
      signal,
      host,
      value: {
        id: "context",
        label: "Conversation owner",
        mount(container: HTMLElement, view: ControlUiViewContext<BoardGetParams>) {
          widgetSignals.push(view.signal);
          container.dataset.nativeOwner = "widget";
          container.textContent = `${view.props.agentId}/${view.props.sessionKey}`;
        },
      },
    };
    const reportError = vi.fn();
    const context = {
      agentSelection: { state: { selectedId: "main" } },
      gateway: {
        subscribe: () => () => undefined,
        snapshot: {
          phase: "connected",
          hello: {
            controlUiWidgetKinds: [
              { pluginId: "identity", kind: "identity:context", label: "Conversation owner" },
            ],
          },
        },
      },
      plugins: {
        registrations: (kind: string) => (kind === "widgets" ? [entry] : []),
        subscribe: () => () => undefined,
        reportError,
      },
    } as unknown as ApplicationContext;
    const provider = createApplicationContextProvider(context);
    onTestFinished(() => provider.remove());
    document.body.append(provider);
    const { client, request } = createClient([
      widget({ contentKind: "plugin", pluginKind: "identity:context" }),
    ]);
    const session = { sessionKey, agentId: "writer" };
    const initial: BoardGetParams = hydrateOwner ? { sessionKey } : session;
    const element = await mountDashboard(initial, client, {}, provider);

    await customElements.whenDefined("openclaw-board-view");
    await vi.waitFor(() => expect(nativeOwner(element)).not.toBeNull());
    expect(request).toHaveBeenCalledWith("board.get", initial);
    expect(nativeOwner(element)?.textContent).toBe(`${initial.agentId}/${sessionKey}`);
    if (hydrateOwner) {
      const previousSignal = widgetSignals.at(-1);
      expect(previousSignal?.aborted).toBe(false);

      element.session = session;
      await element.updateComplete;

      await vi.waitFor(() =>
        expect(nativeOwner(element)?.textContent).toBe(`writer/${sessionKey}`),
      );
      expect(previousSignal?.aborted).toBe(true);
      expect(widgetSignals.at(-1)?.aborted).toBe(false);
    }
    expect(request).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
  },
);

it("waits for the initial gateway snapshot before choosing its expanded state", async () => {
  const sessionKey = "agent:main:delayed";
  const pending = createDeferred<ReturnType<typeof snapshot>>();
  const { client, request } = createClient([], () => pending.promise);
  const element = await mountDashboard({ sessionKey }, client);

  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(expanded(element)).toBe("false");
  expect(emptyLabel(element)).toBeNull();

  pending.resolve(snapshot(sessionKey, [widget()]));

  await vi.waitFor(() => expect(expanded(element)).toBe("true"));
  expect(element.querySelector("openclaw-board-view")).not.toBeNull();
});

it("updates mounted dashboard controls immediately when gateway permissions or connectivity change", async () => {
  const { client, request } = createClient([widget({ grantState: "pending" })]);
  const element = await mountDashboard({ sessionKey: "agent:main:workboard-live-scopes" }, client, {
    canMutate: true,
    canGrant: true,
  });

  const board = await boardView(element);
  await vi.waitFor(() =>
    expect(board.querySelector('[data-test-id="board-grant-allow"]')).not.toBeNull(),
  );
  const allow = board.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]')!;

  expect([board.canMutate, board.canGrant]).toEqual([true, true]);
  expect(allow.disabled).toBe(false);

  toggle(element).click();
  await element.updateComplete;
  expect(expanded(element)).toBe("false");

  for (const permitted of [false, true]) {
    await setPermissions(element, permitted);
    expect(allow.disabled).toBe(!permitted);
    expect(expanded(element)).toBe("false");
  }
  element.connected = false;
  await settle(element);
  await board.querySelector("openclaw-board-widget-cell")?.updateComplete;
  expect(element.querySelector("openclaw-board-view")).toBe(board);
  expect(board.canMutate).toBe(false);
  expect(board.canGrant).toBe(false);
  expect(allow.disabled).toBe(true);
  expect(request).toHaveBeenCalledOnce();
});

it.each([
  { order: "chat-first", session: { sessionKey: "agent:main:workboard-shared" } },
  { order: "dashboard-first", session: { sessionKey: "global", agentId: "work" } },
])(
  "shares $session.sessionKey gateway state without leaking dashboard capabilities in $order order",
  async ({ order, session }) => {
    const { client, request, removeListener } = createClient([widget()]);
    const acquireChat = () =>
      acquireBoardProviderForSession(session, client, true, true, true, true, true);
    let chat = order === "chat-first" ? acquireChat() : undefined;
    onTestFinished(() => chat?.release());
    const dashboard = await mountDashboard(session, client, { canMutate: true, canGrant: false });
    chat ??= acquireChat();

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("board.get", session);
    const board = await boardView(dashboard);
    const chatCapabilities = {
      canPinWidgets: true,
      canPinMcpApps: true,
      canMutate: true,
      canGrant: true,
    };
    expect(chat.provider).toMatchObject(chatCapabilities);
    expect(board).toMatchObject({ canMutate: true, canGrant: false });

    dashboard.canMutate = false;
    await settle(dashboard);

    expect(dashboard.querySelector("openclaw-board-view")).toBe(board);
    expect(board.canMutate).toBe(false);
    expect(chat.provider).toMatchObject(chatCapabilities);
    expect(request).toHaveBeenCalledOnce();

    dashboard.remove();
    await dashboard.updateComplete;
    expect(removeListener).not.toHaveBeenCalled();
    chat.release();
    expect(removeListener).toHaveBeenCalledOnce();
  },
);

it("pauses the board while the dashboard is collapsed", async () => {
  const { client } = createClient([widget({ viewTicket: "ticket", viewTicketTtlMs: 1_200_000 })]);
  const element = await mountDashboard({ sessionKey: "agent:main:workboard-collapse" }, client);
  const board = await boardView(element);
  expect(board.active).toBe(true);

  for (const active of [false, true]) {
    toggle(element).click();
    await settle(element);
    expect(board.active).toBe(active);
  }
});

it("retains local choices across refreshes and initializes each replacement after its snapshot", async () => {
  const sessionKey = "agent:main:dashboard-local-choices";
  const pending = createDeferred<ReturnType<typeof snapshot>>();
  const nextPending = createDeferred<ReturnType<typeof snapshot>>();
  let current = snapshot(
    sessionKey,
    [widget(), widget({ name: "research", tabId: "research", position: 1 })],
    boardTabs(),
  );
  const { client, request, changed } = createClient([], (target) =>
    target?.sessionKey === `${sessionKey}-pending`
      ? pending.promise
      : target?.sessionKey === `${sessionKey}-next`
        ? nextPending.promise
        : current,
  );
  const element = await mountDashboard({ sessionKey }, client);
  await vi.waitFor(() => expect(tab(element, "research")).not.toBeNull());
  tab(element, "research").click();
  await vi.waitFor(() =>
    expect(tab(element, "research").getAttribute("aria-selected")).toBe("true"),
  );
  expect(tab(element, "main").getAttribute("aria-selected")).toBe("false");
  const hidden = (name: string) =>
    element
      .querySelector(`[data-widget-name="${name}"]`)
      ?.closest<HTMLElement>("openclaw-board-widget-cell")?.hidden;
  expect([hidden("research"), hidden("status")]).toEqual([false, true]);
  toggle(element).click();
  await element.updateComplete;

  current = { ...current, revision: 2 };
  changed(sessionKey, 2);
  await vi.waitFor(() =>
    expect(element.querySelector("openclaw-board-view")?.snapshot?.revision).toBe(2),
  );
  expect(expanded(element)).toBe("false");
  expect(tab(element, "research").getAttribute("aria-selected")).toBe("true");

  await selectSession(element, null);
  expect(expanded(element)).toBe("false");
  expect(emptyLabel(element)).toBeNull();
  await selectSession(element, `${sessionKey}-pending`);
  expect(expanded(element)).toBe("false");
  toggle(element).click();
  pending.resolve(snapshot(`${sessionKey}-pending`));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  await element.updateComplete;
  expect(expanded(element)).toBe("true");
  expect(element.querySelector("openclaw-board-view")).toBeNull();

  await selectSession(element, `${sessionKey}-next`);
  expect(expanded(element)).toBe("true");
  nextPending.resolve(snapshot(`${sessionKey}-next`));
  await vi.waitFor(() => expect(expanded(element)).toBe("false"));
  expect(emptyLabel(element)).not.toBeNull();
});

it("releases its provider through detached updates and reacquires only after reconnect", async () => {
  const { client, request, removeListener } = createClient();
  const element = await mountDashboard({ sessionKey: "agent:main:workboard-disposal" }, client);
  await vi.waitFor(() => expect(request).toHaveBeenCalled());

  for (const count of [1, 2]) {
    if (count === 2) {
      document.body.append(element);
      await element.updateComplete;
      expect(request).toHaveBeenCalledTimes(2);
    }
    element.remove();
    await element.updateComplete;
    expect(removeListener).toHaveBeenCalledTimes(count);
    expect(request).toHaveBeenCalledTimes(count);
  }
});
