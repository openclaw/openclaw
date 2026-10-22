import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { resolvePassiveWebsiteIdentity, type BoardDocumentProps } from "./board-document.tsx";
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
    sessions: { describe },
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
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = document.createElement("openclaw-board-document");
  mounted.push(element);
  element.preparedSession = { sessionKey: "dashboard", agentId: "main" };
  element.gatewaySnapshot = {
    client,
    phase: "connected",
    hello: { features: { methods: ["board.get"] } },
  } as ApplicationGatewaySnapshot;
  document.body.append(element);

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
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = mountDocument({
    preparedSession,
    gatewaySnapshot: connected(
      client,
      gatewayHelloForMethods(["board.get", "board.update"], ["operator.write"]),
    ),
  });
  const view = await waitForView(element);
  await settleCells(view);
  const remove = view.querySelector<HTMLElement>(".board-widget__menu-danger")!;
  expect(remove).not.toBeNull();
  await openBoardMenu(view);
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
  remove.click();
  await waitForSolid(() => expect(view.snapshot?.revision).toBe(2));
  await settleCells(view);
  expect(writes).toBe(2);
  expect(view.snapshot?.revision).toBe(2);
  expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(0);
  expect(errors()).toEqual({ board: null, widget: null });
});

it("keeps passive documents live with saved HTML and pure core reports only", async () => {
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
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = mountDocument({
    passive: true,
    preparedSession: { sessionKey: "dashboard", agentId: "main" },
    gatewaySnapshot: connected(client, {
      ...gatewayHelloForMethods(["board.get", "board.widget.appView"]),
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
  expect(view.snapshot?.widgets.map((widget) => widget.name)).toEqual(["status", "session:report"]);
  expect(request).toHaveBeenCalledOnce();
});

it("renders a recognizable website identity card in passive mode for website-only boards", async () => {
  const request = vi.fn(async () =>
    snapshot({
      sessionKey: "dashboard-website",
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [
        boardWidget({
          name: "inventory-app",
          title: "Demo Inventory App",
          contentKind: "plugin",
          pluginKind: "session:website",
          props: { url: "https://inventory.example/app" },
        }),
      ],
    }),
  );
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = mountDocument({
    passive: true,
    preparedSession: { sessionKey: "dashboard-website", agentId: "main" },
    gatewaySnapshot: connected(client, {
      ...gatewayHelloForMethods(["board.get"]),
      controlUiWidgetKinds: [
        { pluginId: "session", kind: "session:website", label: "Website" },
      ],
    }),
  });

  const view = await vi.waitFor(() => {
    const current = element.querySelector("openclaw-board-view");
    expect(current).not.toBeNull();
    return current!;
  });

  // Website widgets remain safely excluded from renderSnapshot
  expect(view.snapshot?.widgets).toEqual([]);

  // Shows the recognizable website card instead of empty board
  await waitForSolid(() => {
    const card = view.querySelector<HTMLElement>('[data-test-id="board-website-preview"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector("strong")?.textContent).toBe("Demo Inventory App");
    expect(card?.querySelector("span:last-child")?.textContent).toBe("Website");
    expect(card?.querySelector(".board-empty__mark")?.getAttribute("aria-hidden")).toBe("true");
    expect(card?.querySelector("svg")).not.toBeNull();
  });

  // Empty board prompt is not shown
  expect(view.querySelector('[data-test-id="board-empty"]')).toBeNull();

  // Executable renderer is not mounted
  expect(view.querySelector("openclaw-website-widget")).toBeNull();
  expect(view.querySelector("iframe")).toBeNull();
});

it("falls back to generic localized website label when widget title is missing or blank", async () => {
  const request = vi.fn(async () =>
    snapshot({
      sessionKey: "dashboard-website-blank",
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [
        boardWidget({
          name: "unnamed-website",
          title: "   ",
          contentKind: "plugin",
          pluginKind: "session:website",
          props: { url: "https://example.com" },
        }),
      ],
    }),
  );
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = mountDocument({
    passive: true,
    preparedSession: { sessionKey: "dashboard-website-blank", agentId: "main" },
    gatewaySnapshot: connected(client, {
      ...gatewayHelloForMethods(["board.get"]),
      controlUiWidgetKinds: [
        { pluginId: "session", kind: "session:website", label: "Website" },
      ],
    }),
  });

  const view = await vi.waitFor(() => {
    const current = element.querySelector("openclaw-board-view");
    expect(current).not.toBeNull();
    return current!;
  });

  await waitForSolid(() => {
    const card = view.querySelector<HTMLElement>('[data-test-id="board-website-preview"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector("strong")?.textContent).toBe("Website");
  });
});

it("renders the empty board prompt for genuinely empty boards in passive mode", async () => {
  const request = vi.fn(async () =>
    snapshot({
      sessionKey: "dashboard-empty",
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [],
    }),
  );
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = mountDocument({
    passive: true,
    preparedSession: { sessionKey: "dashboard-empty", agentId: "main" },
    gatewaySnapshot: connected(client, gatewayHelloForMethods(["board.get"])),
  });

  const view = await vi.waitFor(() => {
    const current = element.querySelector("openclaw-board-view");
    expect(current).not.toBeNull();
    return current!;
  });

  await waitForSolid(() => {
    const emptyPrompt = view.querySelector('[data-test-id="board-empty"]');
    expect(emptyPrompt).not.toBeNull();
    expect(emptyPrompt?.textContent).toContain("A clear board, ready for work");
  });
  expect(view.querySelector('[data-test-id="board-website-preview"]')).toBeNull();
});

it("keeps other unsafe widgets isolated without displaying a website identity card", async () => {
  const request = vi.fn(async () =>
    snapshot({
      sessionKey: "dashboard-mcp-only",
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [
        boardWidget({
          name: "mcp-tools",
          title: "Custom MCP Tools",
          contentKind: "mcp-app",
        }),
        boardWidget({
          name: "browser-dash",
          title: "Browser Dashboard",
          contentKind: "plugin",
          pluginKind: "browser:dashboard",
        }),
      ],
    }),
  );
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = mountDocument({
    passive: true,
    preparedSession: { sessionKey: "dashboard-mcp-only", agentId: "main" },
    gatewaySnapshot: connected(client, {
      ...gatewayHelloForMethods(["board.get"]),
      controlUiWidgetKinds: [
        { pluginId: "browser", kind: "browser:dashboard", label: "Browser" },
      ],
    }),
  });

  const view = await vi.waitFor(() => {
    const current = element.querySelector("openclaw-board-view");
    expect(current).not.toBeNull();
    return current!;
  });

  expect(view.snapshot?.widgets).toEqual([]);
  await waitForSolid(() => {
    expect(view.querySelector('[data-test-id="board-empty"]')).not.toBeNull();
  });
  expect(view.querySelector('[data-test-id="board-website-preview"]')).toBeNull();
  expect(view.querySelector("openclaw-browser-dashboard-widget")).toBeNull();
});

it("renders normal previews for mixed boards without duplicating or executing website widgets", async () => {
  const request = vi.fn(async () =>
    snapshot({
      sessionKey: "dashboard-mixed",
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [
        boardWidget({
          name: "safe-report",
          title: "Production Summary",
          contentKind: "plugin",
          pluginKind: "session:report",
          props: { blocks: [{ type: "text", text: "Summary text" }] },
        }),
        boardWidget({
          name: "service-website",
          title: "Service Dashboard",
          contentKind: "plugin",
          pluginKind: "session:website",
          props: { url: "https://status.example" },
        }),
      ],
    }),
  );
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = mountDocument({
    passive: true,
    preparedSession: { sessionKey: "dashboard-mixed", agentId: "main" },
    gatewaySnapshot: connected(client, {
      ...gatewayHelloForMethods(["board.get"]),
      controlUiWidgetKinds: [
        { pluginId: "session", kind: "session:report", label: "Report" },
        { pluginId: "session", kind: "session:website", label: "Website" },
      ],
    }),
  });

  const view = await vi.waitFor(() => {
    const current = element.querySelector("openclaw-board-view");
    expect(current).not.toBeNull();
    return current!;
  });

  // Only the safe report widget is admitted for rendering
  expect(view.snapshot?.widgets.map((w) => w.name)).toEqual(["safe-report"]);
  await waitForSolid(() => {
    expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(1);
  });
  expect(view.querySelector('[data-test-id="board-empty"]')).toBeNull();
  expect(view.querySelector('[data-test-id="board-website-preview"]')).toBeNull();
  expect(view.querySelector("openclaw-website-widget")).toBeNull();
});

it("deterministically resolves website identity across multiple widgets and tabs", () => {
  // Case 1: Active tab website vs second tab website -> active tab wins
  const multiTab = snapshot({
    tabs: [
      { tabId: "main", title: "Main", position: 0, chatDock: "right" },
      { tabId: "ops", title: "Operations", position: 1, chatDock: "right" },
    ],
    widgets: [
      boardWidget({
        name: "ops-site",
        tabId: "ops",
        title: "Ops Site",
        pluginKind: "session:website",
        position: 0,
      }),
      boardWidget({
        name: "main-site",
        tabId: "main",
        title: "Main Site",
        pluginKind: "session:website",
        position: 0,
      }),
    ],
  });
  expect(resolvePassiveWebsiteIdentity(multiTab, "main")).toEqual({ title: "Main Site" });
  expect(resolvePassiveWebsiteIdentity(multiTab, "ops")).toEqual({ title: "Ops Site" });

  // Case 2: Active tab has non-website widget -> returns null (does not falsely claim website)
  const mcpTab = snapshot({
    tabs: [
      { tabId: "main", title: "Main", position: 0, chatDock: "right" },
      { tabId: "secondary", title: "Secondary", position: 1, chatDock: "right" },
    ],
    widgets: [
      boardWidget({
        name: "mcp-card",
        tabId: "main",
        contentKind: "mcp-app",
        position: 0,
      }),
      boardWidget({
        name: "sec-site",
        tabId: "secondary",
        pluginKind: "session:website",
        title: "Secondary Site",
        position: 0,
      }),
    ],
  });
  expect(resolvePassiveWebsiteIdentity(mcpTab, "main")).toBeNull();

  // Case 3: Active tab is empty, fallback to ordered tabs
  const emptyActiveTab = snapshot({
    tabs: [
      { tabId: "main", title: "Main", position: 0, chatDock: "right" },
      { tabId: "secondary", title: "Secondary", position: 1, chatDock: "right" },
    ],
    widgets: [
      boardWidget({
        name: "sec-site",
        tabId: "secondary",
        pluginKind: "session:website",
        title: "Secondary Site",
        position: 0,
      }),
    ],
  });
  expect(resolvePassiveWebsiteIdentity(emptyActiveTab, "main")).toEqual({ title: "Secondary Site" });

  // Case 4: Multiple website widgets on same tab -> position 0 wins
  const multiWidget = snapshot({
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [
      boardWidget({
        name: "second",
        tabId: "main",
        pluginKind: "session:website",
        title: "Second Site",
        position: 2,
      }),
      boardWidget({
        name: "first",
        tabId: "main",
        pluginKind: "session:website",
        title: "First Site",
        position: 0,
      }),
    ],
  });
  expect(resolvePassiveWebsiteIdentity(multiWidget, "main")).toEqual({ title: "First Site" });
});

it("does not expose website metadata for unauthorized boards", async () => {
  const request = vi.fn(async () => {
    throw new Error("Permission denied: operator cannot read session");
  });
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = mountDocument({
    passive: true,
    preparedSession: { sessionKey: "unauthorized-dashboard", agentId: "main" },
    gatewaySnapshot: connected(client, gatewayHelloForMethods(["board.get"])),
  });

  await waitForSolid(() => {
    const errorAlert = element.querySelector('[role="alert"]');
    expect(errorAlert).not.toBeNull();
    expect(errorAlert?.textContent).toContain("Permission denied");
  });

  expect(element.querySelector("openclaw-board-view")).toBeNull();
  expect(element.querySelector('[data-test-id="board-website-preview"]')).toBeNull();
});
