import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { BoardDocumentProps } from "./board-document.tsx";
import {
  widgetSnapshot,
  testId,
  boardWidget,
  openBoardMenu,
  settleCells,
  snapshot,
} from "./board-view.test-support.ts";
import "./board-document.tsx";

const mounted: HTMLElement[] = [];
const documentClient = (request: GatewayRequestHandler) =>
  ({ request, addEventListener: vi.fn(() => vi.fn()) }) as unknown as GatewayBrowserClient;

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

function mountDocument(props: BoardDocumentProps, parent: HTMLElement = document.body) {
  const element = document.createElement("openclaw-board-document");
  Object.assign(element, props);
  mounted.push(parent === document.body ? element : parent);
  parent.append(element);
  if (parent !== document.body) {
    document.body.append(parent);
  }
  return element;
}
function connected(
  client: GatewayBrowserClient,
  hello: ApplicationGatewaySnapshot["hello"],
): ApplicationGatewaySnapshot {
  return {
    ...createApplicationGateway().gateway.snapshot,
    client,
    phase: "connected",
    hello,
    sessionKey: "agent:main:test",
    assistantAgentId: "main",
  };
}
const preparedSession = { sessionKey: "agent:main:test", agentId: "main" };
const waitForView = (element: HTMLElement, revision = 1) =>
  waitForSolid(() => {
    const view = element.querySelector("openclaw-board-view");
    expect(view?.snapshot?.revision).toBe(revision);
    return view!;
  });
const selectOps = async (view: HTMLElementTagNameMap["openclaw-board-view"]) => {
  view.querySelector<HTMLButtonElement>('[data-board-tab-id="ops"]')!.click();
  await waitForSolid(() => expect(view.activeTabId).toBe("ops"));
};

it("binds an acknowledged conversation only while the dashboard document is mounted", async () => {
  const describe = vi.fn(async () => ({
    session: { key: "global", agentId: "work", kind: "global" as const, updatedAt: 1 },
  }));
  const request = vi.fn(async () => ({
    sessionKey: "agent:work:global",
    revision: 1,
    tabs: [],
    widgets: [],
  }));
  const removeListener = vi.fn();
  const client = {
    request,
    addEventListener: vi.fn(() => removeListener),
  } as unknown as GatewayBrowserClient;
  const gatewaySnapshot = {
    client,
    phase: "connected",
    hello: { features: { methods: ["board.get"] } },
  } as ApplicationGatewaySnapshot;
  const element = mountDocument({
    sessions: { ...createTestSessionCapability(createGatewayHarness(client).gateway), describe },
    sessionKey: "agent:work:main",
    gatewaySnapshot,
  });
  element.remove();
  await element.updateComplete;
  expect(request).not.toHaveBeenCalled();
  expect(describe).not.toHaveBeenCalled();

  document.body.append(element);
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("board.get", {
      sessionKey: "global",
      agentId: "work",
    }),
  );
  await element.updateComplete;
  expect(element.querySelector("openclaw-board-view")).not.toBeNull();
  element.gatewaySnapshot = {
    ...gatewaySnapshot,
    hello: { ...gatewaySnapshot.hello!, features: { methods: ["board.get"] } },
  };
  await element.updateComplete;
  expect(request).toHaveBeenCalledOnce();
  element.remove();
  await element.updateComplete;
  expect(removeListener).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();

  document.body.append(element);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request).toHaveBeenLastCalledWith("board.get", { sessionKey: "global", agentId: "work" });
});

it("uses a prepared gallery session without describing it again", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.describe") {
      throw new Error("prepared sessions must not be described");
    }
    return { sessionKey: "dashboard", revision: 1, tabs: [], widgets: [] };
  });
  mountDocument({
    preparedSession: { sessionKey: "dashboard", agentId: "main" },
    gatewaySnapshot: {
      client: documentClient(request),
      phase: "connected",
      hello: { features: { methods: ["board.get"] } },
    } as ApplicationGatewaySnapshot,
  });

  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("board.get", {
      sessionKey: "dashboard",
      agentId: "main",
    }),
  );
  expect(request).toHaveBeenCalledOnce();
});

it("retains the board and selected tab across transport loss but retires them for another client", async () => {
  const initial = snapshot();
  const refreshed = createDeferred<ReturnType<typeof snapshot>>();
  const replacement = createDeferred<ReturnType<typeof snapshot>>();
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(initial)
    .mockReturnValue(refreshed.promise);
  const client = createTestGatewayClient(request);
  const hello = gatewayHelloForMethods(
    ["board.get", "board.update"],
    ["operator.write", "operator.approvals"],
  );
  const online = connected(client, hello);
  const element = mountDocument({ preparedSession, gatewaySnapshot: online });
  const view = await waitForView(element);
  await settleCells(view);
  await selectOps(view);

  element.gatewaySnapshot = { ...online, phase: "reconnecting", hello: null };
  await element.updateComplete;
  expect(element.querySelector("openclaw-board-view")).toBe(view);
  expect(view.activeTabId).toBe("ops");
  expect(view.snapshot?.revision).toBe(1);
  expect(view.canMutate).toBe(false);
  expect(view.canGrant).toBe(false);
  expect(request).toHaveBeenCalledOnce();

  element.gatewaySnapshot = online;
  await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
  expect(element.querySelector("openclaw-board-view")).toBe(view);
  expect(view.activeTabId).toBe("ops");
  refreshed.resolve({ ...initial, revision: 2 });
  await waitForSolid(() => expect(view.snapshot?.revision).toBe(2));
  expect(view.canMutate).toBe(true);

  const nextClient = createTestGatewayClient(() => replacement.promise);
  element.gatewaySnapshot = { ...online, client: nextClient };
  await element.updateComplete;
  expect(element.querySelector("openclaw-board-view")).toBeNull();
  replacement.resolve(initial);
  const nextView = await waitForSolid(() => {
    const current = element.querySelector("openclaw-board-view");
    expect(current).not.toBeNull();
    expect(current).not.toBe(view);
    return current!;
  });
  expect(nextView.activeTabId).toBe("main");

  element.gatewaySnapshot = {
    ...online,
    client: nextClient,
    hello: { ...hello, auth: { role: "operator", scopes: [] } },
  };
  await element.updateComplete;
  expect(element.querySelector("openclaw-board-view")).toBeNull();
});

it.each(["account", "recovery"] as const)(
  "retires the board when the same client's %s identity changes",
  async (identity) => {
    const initial = snapshot({ widgets: [] });
    const replacement = createDeferred<ReturnType<typeof snapshot>>();
    const request = createGatewayRequestMock()
      .mockResolvedValueOnce(initial)
      .mockReturnValue(replacement.promise);
    const client = createTestGatewayClient(request);
    const hello = gatewayHelloForMethods(["board.get"]);
    hello.auth = { ...hello.auth, recoveryScope: "first-scope" };
    const source = createApplicationGateway({
      ...connected(client, hello),
      selfUser: { id: "first-user", name: "First user" },
    });
    const provider = createApplicationContextProvider({
      gateway: source.gateway,
    } as ApplicationContext);
    const element = mountDocument(
      { preparedSession, gatewaySnapshot: source.gateway.snapshot },
      provider,
    );
    const view = await waitForView(element);
    await selectOps(view);

    source.publish({
      ...source.gateway.snapshot,
      ...(identity === "account"
        ? { selfUser: { id: "second-user", name: "Second user" } }
        : { hello: { ...hello, auth: { ...hello.auth, recoveryScope: "second-scope" } } }),
    });
    element.gatewaySnapshot = source.gateway.snapshot;
    await element.updateComplete;
    expect(element.querySelector("openclaw-board-view")).toBeNull();
    replacement.resolve({ ...initial, revision: 2 });
    await waitForSolid(() => {
      const current = element.querySelector("openclaw-board-view");
      expect(current?.snapshot?.revision).toBe(2);
      expect(current).not.toBe(view);
      expect(current?.activeTabId).toBe("main");
    });
  },
);

it("retains failed Remove feedback after automatic unchanged dashboard reconciliation", async () => {
  const recovery = createDeferred<ReturnType<typeof snapshot>>();
  const recoveryRequested = createDeferred();
  const initial = widgetSnapshot();
  let reads = 0;
  let writes = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "board.update") {
      if (++writes === 1) {
        throw new Error("Dashboard write rejected");
      }
      return { ...initial, revision: 2, widgets: [] };
    }
    if (method !== "board.get") {
      throw new Error(`Unexpected request: ${method}`);
    }
    if (++reads === 1) {
      return initial;
    }
    recoveryRequested.resolve();
    return recovery.promise;
  });
  const element = mountDocument({
    preparedSession,
    gatewaySnapshot: connected(
      documentClient(request),
      gatewayHelloForMethods(["board.get", "board.update"], ["operator.write"]),
    ),
  });
  const view = await waitForView(element);
  await settleCells(view);
  await openBoardMenu(view);
  const remove = view.querySelector<HTMLElement>(".board-widget__menu-danger")!;
  expect(remove).not.toBeNull();
  remove.click();
  await recoveryRequested.promise;
  await settleCells(view);
  expect(request).toHaveBeenCalledWith("board.update", {
    sessionKey: initial.sessionKey,
    agentId: "main",
    ops: [{ kind: "widget_remove", name: "alpha" }],
  });
  const errors = () => ({
    board: view.querySelector(".board-view__error")?.textContent?.trim() ?? null,
    widget: testId(view, "board-widget-action-error")?.textContent?.trim() ?? null,
  });
  await waitForSolid(() => {
    expect(errors().board).toContain("could not be saved");
    expect(errors().widget).toContain("Dashboard write rejected");
  });
  const beforeRefresh = errors();
  const previousSnapshot = view.snapshot;
  recovery.resolve(structuredClone(initial));
  await waitForSolid(() => expect(view.snapshot).not.toBe(previousSnapshot));
  await settleCells(view);
  expect(view.snapshot?.revision).toBe(1);
  expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(1);
  expect(errors()).toEqual(beforeRefresh);

  await openBoardMenu(view);
  view.querySelector<HTMLElement>(".board-widget__menu-danger")!.click();
  await waitForSolid(() => expect(view.snapshot?.revision).toBe(2));
  await settleCells(view);
  expect(writes).toBe(2);
  expect(view.snapshot?.revision).toBe(2);
  expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(0);
  expect(errors()).toEqual({ board: null, widget: null });
});

it.each([
  { scope: "operator.sessions.read", sharingRole: "owner", archived: false, canMutate: false },
  { scope: "operator.sessions.write", sharingRole: "viewer", archived: false, canMutate: false },
  { scope: "operator.sessions.write", sharingRole: "owner", archived: false, canMutate: true },
  { scope: "operator.sessions.write", sharingRole: "owner", archived: true, canMutate: true },
] as const)(
  "renders focused documents with $scope as $sharingRole (archived=$archived)",
  async ({ scope, sharingRole, archived, canMutate }) => {
    let board = widgetSnapshot();
    let row: GatewaySessionRow = {
      key: preparedSession.sessionKey,
      agentId: "main",
      sessionId: "document-session",
      kind: "direct",
      updatedAt: 1,
      sharingRole,
      archived,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return { session: row };
      }
      if (method === "board.update") {
        board = { ...board, revision: 2, widgets: [] };
        return board;
      }
      if (method === "board.get") {
        return board;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = documentClient(request);
    const hello = gatewayHelloForMethods(
      ["board.get", "board.update", "sessions.describe"],
      [scope],
    );
    const source = createGatewayHarness(client, undefined, { initial: { hello } });
    const sessions = createTestSessionCapability(source.gateway);
    const element = mountDocument({
      preparedSession,
      sessions,
      gatewaySnapshot: connected(client, hello),
    });
    const view = await waitForView(element);
    await settleCells(view);
    expect(view.canMutate).toBe(canMutate);
    expect(view.canGrant).toBe(false);
    if (canMutate) {
      await openBoardMenu(view);
      view.querySelector<HTMLElement>(".board-widget__menu-danger")!.click();
      await waitForSolid(() => expect(view.snapshot?.widgets).toHaveLength(0));
      expect(request).toHaveBeenCalledWith(
        "board.update",
        expect.objectContaining({ ops: [{ kind: "widget_remove", name: "alpha" }] }),
      );
    } else {
      expect(view.querySelector(".board-widget__menu-trigger")).toBeNull();
    }
    row = { ...row, sharingRole: "viewer", updatedAt: 2 };
    source.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: row.key,
        agentId: "main",
        sessionId: row.sessionId,
        reason: "patch",
        ancestorSessions: [],
        session: row,
      },
    });
    await waitForSolid(() => expect(view.canMutate).toBe(false));
    if (canMutate) {
      row = { ...row, sessionId: "replacement-session", sharingRole, updatedAt: 3 };
      source.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: row.key,
          agentId: "main",
          sessionId: row.sessionId,
          reason: "reset",
          ancestorSessions: [],
          session: row,
        },
      });
      await waitForSolid(() => {
        const replacement = element.querySelector("openclaw-board-view");
        expect(replacement?.canMutate).toBe(true);
        expect(replacement?.snapshot?.widgets).toHaveLength(0);
      });
    }
    element.gatewaySnapshot = {
      ...connected(client, hello),
      hello: { ...hello, auth: { role: "operator", scopes: [] } },
    };
    await element.updateComplete;
    expect(element.querySelector("openclaw-board-view")).toBeNull();
  },
);

it.each(["missing", "revoked"])(
  "does not render a %s focused session after a held descriptor",
  async (state) => {
    const described = createDeferred<{ session: GatewaySessionRow | null }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return described.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = documentClient(request);
    const hello = gatewayHelloForMethods(
      ["board.get", "sessions.describe"],
      ["operator.sessions.write"],
    );
    const source = createGatewayHarness(client, undefined, { initial: { hello } });
    const sessions = createTestSessionCapability(source.gateway);
    const element = mountDocument({
      preparedSession,
      sessions,
      gatewaySnapshot: connected(client, hello),
    });
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.describe",
        expect.objectContaining({ key: preparedSession.sessionKey }),
      ),
    );
    if (state === "revoked") {
      element.gatewaySnapshot = {
        ...connected(client, hello),
        hello: { ...hello, auth: { role: "operator", scopes: [] } },
      };
      await element.updateComplete;
    }
    described.resolve({
      session:
        state === "missing"
          ? null
          : {
              key: preparedSession.sessionKey,
              agentId: "main",
              sessionId: "hidden-session",
              kind: "direct",
              updatedAt: 1,
              sharingRole: "owner",
            },
    });
    await waitForSolid(() => expect(element.querySelector('[role="status"]')).not.toBeNull());
    expect(element.querySelector("openclaw-board-view")).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  },
);

it.each(["operator.read", "operator.sessions.read", "operator.sessions.write"])(
  "keeps passive documents live with saved HTML and pure core reports only (%s)",
  async (scope) => {
    const request = vi.fn(async () =>
      snapshot({
        sessionKey: "dashboard",
        tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
        widgets: [
          boardWidget({
            name: "status",
            grantState: "granted",
            frameUrl: "data:text/html,status",
          }),
          boardWidget({
            name: "tools",
            contentKind: "mcp-app",
            grantState: "granted",
          }),
          ...["session:report", "session:progress", "custom:report"].map((pluginKind) =>
            boardWidget({
              name: pluginKind,
              contentKind: "plugin",
              pluginKind,
              props: { blocks: [{ type: "text", text: "Saved summary" }] },
            }),
          ),
        ],
      }),
    );
    const element = mountDocument({
      passive: true,
      preparedSession: { sessionKey: "dashboard", agentId: "main" },
      gatewaySnapshot: connected(documentClient(request), {
        ...gatewayHelloForMethods(["board.get", "board.widget.appView"], [scope]),
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:report", label: "Report" },
          { pluginId: "session", kind: "session:progress", label: "Progress" },
          { pluginId: "custom", kind: "custom:report", label: "Custom report" },
        ],
      }),
    });

    const view = await vi.waitFor(() => {
      const current = element.querySelector("openclaw-board-view");
      expect(current).not.toBeNull();
      return current!;
    });
    expect(view.active).toBe(true);
    expect(view.bridgeEnabled).toBe(false);
    expect(view.canMutate).toBe(false);
    expect(view.canGrant).toBe(false);
    expect(view.snapshot?.widgets.map((widget) => widget.name)).toEqual([
      "status",
      "session:report",
    ]);
    expect(request).toHaveBeenCalledOnce();
  },
);
