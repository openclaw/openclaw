import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { boardWidget, settleCells, snapshot } from "./board-view.test-support.ts";
import "./board-document.tsx";

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

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
  const element = document.createElement("openclaw-board-document");
  mounted.push(element);
  element.sessions = { describe };
  element.sessionKey = "agent:work:main";
  element.gatewaySnapshot = {
    client,
    phase: "connected",
    hello: { features: { methods: ["board.get"] } },
  } as ApplicationGatewaySnapshot;
  document.body.append(element);
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
    client,
    phase: "connected",
    hello: { features: { methods: ["board.get"] } },
  } as ApplicationGatewaySnapshot;
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

it("retains failed Remove feedback after automatic unchanged dashboard reconciliation", async () => {
  const recovery = createDeferred<ReturnType<typeof snapshot>>();
  const recoveryRequested = createDeferred();
  const initial = snapshot({ widgets: [boardWidget()] });
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
  const element = document.createElement("openclaw-board-document");
  mounted.push(element);
  element.preparedSession = { sessionKey: initial.sessionKey, agentId: "main" };
  element.gatewaySnapshot = {
    client,
    phase: "connected",
    hello: {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["board.get", "board.update"] },
    },
  } as ApplicationGatewaySnapshot;
  document.body.append(element);
  const view = await waitForSolid(() => {
    const current = element.querySelector("openclaw-board-view");
    expect(current?.snapshot?.revision).toBe(1);
    return current!;
  });
  await settleCells(view);
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
    widget:
      view.querySelector('[data-test-id="board-widget-action-error"]')?.textContent?.trim() ?? null,
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

  remove.click();
  await waitForSolid(() => expect(view.snapshot?.revision).toBe(2));
  await settleCells(view);
  expect(writes).toBe(2);
  expect(view.snapshot?.revision).toBe(2);
  expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(0);
  expect(errors()).toEqual({ board: null, widget: null });
});

it("keeps passive documents live with saved HTML and pure core reports only", async () => {
  const request = vi.fn(async () => ({
    sessionKey: "dashboard",
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0 }],
    widgets: [
      {
        name: "status",
        tabId: "main",
        contentKind: "html",
        sizeW: 12,
        sizeH: 6,
        position: 0,
        grantState: "granted",
        revision: 1,
        frameUrl: "data:text/html,status",
      },
      {
        name: "tools",
        tabId: "main",
        contentKind: "mcp-app",
        sizeW: 12,
        sizeH: 6,
        position: 1,
        grantState: "granted",
        revision: 1,
      },
      ...["session:report", "session:progress", "custom:report"].map((pluginKind) => ({
        name: pluginKind,
        tabId: "main",
        contentKind: "plugin",
        pluginKind,
        props: { blocks: [{ type: "text", text: "Saved summary" }] },
        sizeW: 12,
        sizeH: 6,
        position: 2,
        grantState: "none",
        revision: 1,
      })),
    ],
  }));
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = document.createElement("openclaw-board-document");
  mounted.push(element);
  element.passive = true;
  element.preparedSession = { sessionKey: "dashboard", agentId: "main" };
  element.gatewaySnapshot = {
    client,
    phase: "connected",
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["board.get", "board.widget.appView"] },
      controlUiWidgetKinds: [
        { pluginId: "session", kind: "session:report", label: "Report" },
        { pluginId: "session", kind: "session:progress", label: "Progress" },
        { pluginId: "custom", kind: "custom:report", label: "Custom report" },
      ],
    },
  } as ApplicationGatewaySnapshot;
  document.body.append(element);

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
