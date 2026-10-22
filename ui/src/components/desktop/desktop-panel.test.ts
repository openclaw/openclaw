/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { DesktopClient, DesktopConnectionHandle } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  connectedClient as connected,
  desktopRequest,
  desktopEnvironment,
  expectObserve,
  mountDesktop as mount,
  rpcCalls,
  type RpcParams,
  selectSizing,
  sizingMenu,
  unmountPanel,
  usePanelStorage,
  waitForConnections,
  updatePanel,
} from "./desktop-panel.test-support.ts";

const node = { id: "node:workstation", type: "node", status: "available", desktop: true };
type Reply = (params?: RpcParams) => unknown;
const workerInventory = {
  "environments.list": () => ({ environments: [desktopEnvironment] }),
  "environments.status": () => desktopEnvironment,
};
function viewer(handlers: Record<string, Reply>, fallback?: Reply) {
  const request = desktopRequest(handlers, fallback);
  const gateway = createGatewayClient(request);
  const disconnect = vi.fn();
  return { request, gateway, disconnect, connect: connected({ disconnect }) };
}
type Panel = ReturnType<typeof createPanel>;
function nodeConnected(gateway: ReturnType<typeof createGatewayClient>) {
  gateway.emit("presence", {
    presence: [{ deviceId: "workstation", roles: ["node"], reason: "connect" }],
  });
}
function expectViewer(panel: Panel, connect: ReturnType<typeof connected>, disconnect: unknown) {
  expect(connect.mock.calls[0]?.[0].isCurrent()).toBe(true);
  expect(disconnect).not.toHaveBeenCalled();
  expect(panel.querySelector(".desktop-surface")).not.toBeNull();
}

async function handoffFixture(initialControl = false, delayedHandle = false) {
  const observe = createDeferred<unknown>();
  const replacement = createDeferred<DesktopConnectionHandle>();
  const previous = createConnectionHandle();
  const next = createConnectionHandle();
  const canvas = document.createElement("canvas");
  const request = desktopRequest(workerInventory, (params) =>
    (delayedHandle ? params?.control !== initialControl : Boolean(params?.control))
      ? observe.promise
      : {
          transport: "rfb",
          wsPath: "/view",
          control: initialControl,
          ...(delayedHandle ? { canResize: true } : {}),
        },
  );
  const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
    if (options.viewOnly !== !initialControl) {
      if (delayedHandle) {
        options.target.append(canvas);
      }
      return delayedHandle ? replacement.promise : next;
    }
    options.onConnect?.();
    return previous;
  });
  const gateway = createGatewayClient(request);
  const panel = await mount(gateway.client, connect, {
    embedded: true,
    presented: true,
    requestedSource: desktopEnvironment.id,
    ...(delayedHandle ? { documentMode: true, documentControl: initialControl } : {}),
  });
  return { observe, replacement, previous, next, canvas, request, connect, gateway, panel };
}

describe("embedded desktop panel presentation", () => {
  usePanelStorage();

  it("follows the session desktop and retires its connection before resolving a new placement", async () => {
    const replacement = { ...desktopEnvironment, id: "worker-desktop-2" };
    let refresh: Promise<void> | undefined;
    const request = desktopRequest({
      "environments.status": async (params) => {
        await refresh;
        return params?.environmentId === replacement.id ? replacement : desktopEnvironment;
      },
    });
    const disconnect = vi.fn();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      expect(options.target.isConnected).toBe(true);
      options.onConnect?.();
      return createConnectionHandle({ disconnect });
    });
    const panel = await mount(createGatewayClient(request).client, connect, {
      embedded: true,
      presented: true,
      sessionKey: "agent:main:cloud",
      requestedSource: desktopEnvironment.id,
    });

    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("environments.status", {
      environmentId: desktopEnvironment.id,
    });
    expect(request).toHaveBeenCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: desktopEnvironment.id },
      control: false,
    });

    const nextInventory = createDeferred();
    refresh = nextInventory.promise;
    updatePanel(panel, { requestedSource: replacement.id });
    await panel.updateComplete;
    expect(disconnect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    nextInventory.resolve();
    refresh = undefined;
    await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
    expectObserve(request, replacement.id);

    updatePanel(panel, { requestedSource: null });
    await panel.updateComplete;
    await waitForSolid(() => {
      expect(disconnect).toHaveBeenCalledTimes(2);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(rpcCalls(request, "sessions.describe")).toHaveLength(0);
      expect(rpcCalls(request, "environments.list")).toHaveLength(0);
      expect(panel.querySelector(".desktop-picker")).toBeNull();
      expect(panel.textContent).toContain("The requested desktop is unavailable");
    });
  });

  it.each(["session", "floating"])(
    "discovers a late node in the %s presenter without retaining credentials",
    async (presentation) => {
      const sessionKey = "agent:main:desktop";
      const picker = presentation === "floating";
      let online = true;
      const request = desktopRequest(
        {
          "environments.list": () => ({ environments: online ? [node] : [] }),
          "environments.status": () => ({ ...node, desktop: online }),
          "sessions.describe": () => ({ session: { key: sessionKey, execNode: "workstation" } }),
        },
        (params) => {
          if (!params?.credentials) {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "Screen Sharing requires account credentials",
              details: { code: "DESKTOP_CREDENTIALS_REQUIRED", auth: "ard-account" },
            });
          }
          expect(params.credentials).toEqual({ username: "operator", password: "synthetic" });
          return {
            transport: "rfb",
            wsPath: "/desktop/observe?token=synthetic",
            auth: "ard-account",
            preauthenticated: true,
            control: false,
          };
        },
      );
      const gateway = createGatewayClient(request);
      const disconnect = vi.fn();
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        expect(options.credentials).toBeUndefined();
        options.onConnect?.();
        return createConnectionHandle({ disconnect });
      });
      const panel = await mount(gateway.client, connect, {
        documentMode: !picker,
        embedded: false,
        presented: true,
        sessionKey: presentation === "session" ? sessionKey : null,
        requestedSource: null,
      });
      await panel.updateComplete;
      if (presentation === "floating") {
        window.dispatchEvent(
          new CustomEvent("openclaw:desktop-toggle", { detail: { open: true } }),
        );
      }
      if (picker) {
        await waitForSolid(() =>
          expect(panel.querySelector(".desktop-environment")).not.toBeNull(),
        );
        clickPanelButton(panel);
      }
      const credentialForm = (stage: "initial" | "reconnected") => {
        const form = panel.querySelector<HTMLFormElement>("form");
        const username = form?.querySelector<HTMLInputElement>('input[name="username"]');
        const password = form?.querySelector<HTMLInputElement>('input[name="password"]');
        if (!form || !username || !password) {
          throw new Error(`expected the ${stage} ARD credential form`);
        }
        return { form, username, password };
      };
      const initial = await waitForSolid(() => credentialForm("initial"));
      initial.username.value = "operator";
      initial.password.value = "synthetic";
      initial.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());

      updatePanel(panel, { available: false, client: null });
      await panel.updateComplete;
      expect(disconnect).toHaveBeenCalledOnce();
      online = false;
      updatePanel(panel, { client: gateway.client, available: true });
      await panel.updateComplete;
      await waitForSolid(() => {
        expect(panel.querySelector(".desktop-picker")).not.toBeNull();
        expect(panel.querySelectorAll(".desktop-environment")).toHaveLength(0);
      });
      const observations = () => rpcCalls(request, "desktop.observe");
      expect(observations()).toHaveLength(2);

      nodeConnected(gateway);
      await panel.updateComplete;
      expect(panel.querySelectorAll(".desktop-environment")).toHaveLength(0);
      expect(observations()).toHaveLength(2);
      online = true;
      gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
      if (picker) {
        await waitForSolid(() =>
          expect(panel.querySelector(".desktop-environment")?.textContent ?? "").toContain(node.id),
        );
        expect(observations()).toHaveLength(2);
        clickPanelButton(panel);
      }
      const reconnected = await waitForSolid(() => credentialForm("reconnected"));
      expect(observations().at(-1)?.[1]).toEqual({
        source: { kind: "node", nodeId: "workstation" },
        control: false,
      });
      expect([reconnected.username.value, reconnected.password.value]).toEqual(["", ""]);
      gateway.emit("node.runnerInventory.changed", { nodeId: "workstation" });
      await panel.updateComplete;
      expect(observations()).toHaveLength(3);
      expect(connect).toHaveBeenCalledOnce();
    },
  );

  it("discovers a node that arrives before an older empty inventory response finishes", async () => {
    const empty = createDeferred<{ environments: [] }>();
    let inventory: Promise<{ environments: (typeof node)[] }> = empty.promise;
    const { request, gateway, disconnect, connect } = viewer({
      "environments.status": async () =>
        (await inventory).environments[0] ?? { ...node, desktop: false },
      "environments.list": () => inventory,
    });
    const panel = await mount(gateway.client, connect, {
      documentMode: true,
      requestedSource: node.id,
    });
    try {
      await panel.updateComplete;
      expect(request).toHaveBeenCalledWith("environments.status", { environmentId: node.id });
      const initialInventoryRequest = request.mock.results[0]!.value;
      inventory = Promise.resolve({ environments: [node] });
      nodeConnected(gateway);
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      empty.resolve({ environments: [] });
      await initialInventoryRequest;
      await panel.updateComplete;
      expectViewer(panel, connect, disconnect);
    } finally {
      empty.resolve({ environments: [] });
      await unmountPanel(panel);
      await panel.updateComplete;
    }
  });

  it("ignores a session lookup superseded by a renewed target refresh", async () => {
    const session = { key: "agent:main:desktop", execNode: "workstation" };
    const oldSession = createDeferred<unknown>();
    const nextInventory = createDeferred<{ environments: (typeof node)[] }>();
    let inventory: Promise<{ environments: (typeof node)[] }> = Promise.resolve({
      environments: [],
    });
    let sessionRead: Promise<unknown> = Promise.resolve({ session });
    const { request, gateway, disconnect, connect } = viewer({
      "environments.list": () => inventory,
      "environments.status": async () =>
        (await inventory).environments[0] ?? { ...node, desktop: false },
      "sessions.describe": () => sessionRead,
    });
    const panel = await mount(gateway.client, connect, {
      documentMode: true,
      sessionKey: session.key,
    });
    let oldSessionRequest: Promise<unknown> | undefined;
    const startOldSessionRead = async () => {
      const reads = rpcCalls(request, "sessions.describe").length;
      sessionRead = oldSession.promise;
      gateway.emit("sessions.changed", { sessionKey: session.key });
      await waitForSolid(() =>
        expect(rpcCalls(request, "sessions.describe")).toHaveLength(reads + 1),
      );
      oldSessionRequest = request.mock.results.at(-1)!.value;
      sessionRead = Promise.resolve({ session });
    };
    const retired = { session: { key: session.key, placement: { state: "reclaimed" } } };
    try {
      await waitForSolid(() => expect(panel.querySelector(".desktop-picker")).not.toBeNull());
      await startOldSessionRead();
      inventory = nextInventory.promise;
      nodeConnected(gateway);
      oldSession.resolve(retired);
      await oldSessionRequest;
      await panel.updateComplete;
      nextInventory.resolve({ environments: [node] });
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      expectViewer(panel, connect, disconnect);
    } finally {
      oldSession.resolve(retired);
      nextInventory.resolve({ environments: [] });
      await unmountPanel(panel);
      await panel.updateComplete;
    }
  });

  it.each(["hide", "replace", "unmount"] as const)(
    "ignores queued presence after the picker is retired by %s",
    async (action) => {
      const request = vi.fn(async () => ({ environments: [] }));
      const replacementRequest = vi.fn(async () => ({ environments: [] }));
      const gateway = createGatewayClient(request);
      const replacement = createGatewayClient(replacementRequest);
      const panel = await mount(gateway.client, undefined, { embedded: true, presented: true });
      await panel.updateComplete;
      const reads = request.mock.calls.length;
      if (action === "hide") {
        updatePanel(panel, { presented: false });
      } else if (action === "replace") {
        updatePanel(panel, { client: replacement.client });
      } else {
        panel.remove();
      }
      gateway.emit("presence", { presence: [] });
      expect(request).toHaveBeenCalledTimes(reads);
      expect(replacementRequest).not.toHaveBeenCalled();
      await panel.updateComplete;
      gateway.emit("presence", { presence: [] });
      expect(request).toHaveBeenCalledTimes(reads);
      await unmountPanel(panel);
      const replacementReads = replacementRequest.mock.calls.length;
      replacement.emit("presence", { presence: [] });
      await panel.updateComplete;
      expect(replacementRequest).toHaveBeenCalledTimes(replacementReads);
    },
  );

  it("keeps a standalone picker selection and control across config updates", async () => {
    const selected = { ...desktopEnvironment, id: "worker-manual" };
    let environments = [desktopEnvironment, selected];
    const { request, gateway, disconnect, connect } = viewer({
      "environments.list": () => ({ environments }),
      "environments.status": (params) =>
        environments.find((environment) => environment.id === params?.environmentId),
    });
    const inventoryChanged = () => gateway.emit("config.changed", { hash: "desktop-labs", ts: 1 });
    const onFocusTargetChange = vi.fn();
    const panel = await mount(gateway.client, connect, {
      embedded: true,
      presented: true,
      requestedSource: desktopEnvironment.id,
      onFocusTargetChange,
    });
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    clickPanelButton(panel, 'button[aria-label="Disconnect"]');
    await panel.updateComplete;
    environments = [];
    inventoryChanged();
    await waitForSolid(() =>
      expect(panel.querySelectorAll(".desktop-environment")).toHaveLength(0),
    );
    expect(panel.querySelector(".desktop-picker")).not.toBeNull();
    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(rpcCalls(request, "sessions.describe")).toHaveLength(0);

    environments = [selected, desktopEnvironment];
    inventoryChanged();
    await waitForSolid(() =>
      expect(panel.querySelectorAll(".desktop-environment")).toHaveLength(2),
    );
    clickPanelButton(panel);
    await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(panel.querySelectorAll('button[aria-label="Take control"]')).toHaveLength(1);
    clickPanelButton(panel, 'button[aria-label="Take control"]');
    await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(3));
    const selectedConnection = connect.mock.calls.at(-1)?.[0];
    expect(selectedConnection?.viewOnly).toBe(false);
    expectObserve(request, selected.id, true);
    await panel.updateComplete;
    const selectedFocus = { kind: "desktop", source: selected.id, control: true };
    expect(onFocusTargetChange).toHaveBeenLastCalledWith(selectedFocus);

    environments = [desktopEnvironment];
    inventoryChanged();
    await panel.updateComplete;
    expect({
      connected: selectedConnection?.isCurrent(),
      connections: connect.mock.calls.length,
      disconnects: disconnect.mock.calls.length,
      focus: onFocusTargetChange.mock.calls.at(-1)?.[0],
    }).toEqual({ connected: true, connections: 3, disconnects: 2, focus: selectedFocus });
    expect(panel.textContent).not.toContain("Agent input is paused");
    clickPanelButton(panel, 'button[aria-label="Switch to view only"]');
    await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(4));
    expect(connect.mock.calls.at(-1)?.[0].viewOnly).toBe(true);
    expect(panel.textContent).not.toContain("Agent input is paused");
  });

  it.each(["before", "after"] as const)(
    "keeps focused session updates current and retains a choice across a lookup started %s selection",
    async (lookupTiming) => {
      const sessionKey = "agent:main:focused";
      const selected = { ...desktopEnvironment, id: "worker-manual" };
      const active = {
        key: sessionKey,
        kind: "direct",
        placement: { state: "active", environmentId: desktopEnvironment.id },
      };
      const reclaimed = { ...active, placement: { state: "reclaimed" } };
      let sessionRead: Promise<unknown> | undefined;
      const { request, gateway, disconnect, connect } = viewer({
        "environments.list": () => ({ environments: [selected, desktopEnvironment] }),
        "environments.status": (params) =>
          params?.environmentId === selected.id ? selected : desktopEnvironment,
        "sessions.describe": () => sessionRead ?? { session: active },
      });
      const onFocusTargetChange = vi.fn();
      const panel = await mount(gateway.client, connect, {
        documentMode: true,
        sessionKey,
        onFocusTargetChange,
      });
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      const descriptions = () => rpcCalls(request, "sessions.describe");
      const changed = (key = sessionKey) => gateway.emit("sessions.changed", { sessionKey: key });

      changed("agent:main:unrelated");
      await panel.updateComplete;
      expect(descriptions()).toHaveLength(1);
      changed();
      await waitForSolid(() => expect(descriptions()).toHaveLength(2));
      await panel.updateComplete;
      expect(disconnect).not.toHaveBeenCalled();

      const pending = createDeferred<unknown>();
      sessionRead = pending.promise;
      changed();
      await waitForSolid(() => expect(descriptions()).toHaveLength(3));
      clickPanelButton(panel, 'button[aria-label="Take control"]');
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
      pending.resolve({ session: reclaimed });
      await waitForSolid(() => expect(panel.querySelector(".desktop-picker")).not.toBeNull());
      expect(disconnect).toHaveBeenCalledTimes(2);

      sessionRead = undefined;
      changed();
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(3));
      const stale = createDeferred<unknown>();
      sessionRead = stale.promise;
      changed();
      await waitForSolid(() => expect(descriptions()).toHaveLength(5));
      const staleRequest = request.mock.results.at(-1)!.value;
      sessionRead = Promise.resolve({ session: reclaimed });
      changed();
      await waitForSolid(() => expect(panel.querySelector(".desktop-picker")).not.toBeNull());
      stale.resolve({ session: active });
      await staleRequest;
      await panel.updateComplete;
      expect(connect).toHaveBeenCalledTimes(3);
      const lookup = createDeferred<unknown>();
      sessionRead = lookup.promise;
      let lookupRequest: Promise<unknown> | undefined;
      const startLookup = async () => {
        const count = descriptions().length;
        changed();
        await waitForSolid(() => expect(descriptions()).toHaveLength(count + 1));
        lookupRequest = request.mock.results.at(-1)!.value;
      };
      if (lookupTiming === "before") {
        await startLookup();
      }
      clickPanelButton(panel);
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(4));
      clickPanelButton(panel, 'button[aria-label="Take control"]');
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(5));
      const chosenConnection = connect.mock.calls.at(-1)?.[0];
      expect(chosenConnection?.viewOnly).toBe(false);
      if (lookupTiming === "after") {
        await startLookup();
      }
      lookup.resolve({ session: active });
      await lookupRequest;
      await panel.updateComplete;
      expect
        .soft({
          current: chosenConnection?.isCurrent(),
          focus: onFocusTargetChange.mock.calls.at(-1)?.[0],
        })
        .toEqual({
          current: true,
          focus: { kind: "desktop", source: selected.id, control: true },
        });

      // A document URL selects its own source even after the user chose another viewer.
      const connections = connect.mock.calls.length;
      updatePanel(panel, { sessionKey: null, requestedSource: desktopEnvironment.id });
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(connections + 1));
      updatePanel(panel, { requestedSource: selected.id });
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(connections + 2));
      expectObserve(request, selected.id);
      expect(onFocusTargetChange).toHaveBeenLastCalledWith({
        kind: "desktop",
        source: selected.id,
        control: false,
      });
      await unmountPanel(panel);
      expect(gateway.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { initialControl: false, handleTiming: "before" },
    { initialControl: false, handleTiming: "after" },
    { initialControl: true, handleTiming: "before" },
    { initialControl: true, handleTiming: "after" },
  ] as const)(
    "retains control=$initialControl until RFB connects with the handle $handleTiming the callback",
    async ({ initialControl, handleTiming }) => {
      const { observe, replacement, previous, next, canvas, request, connect, gateway, panel } =
        await handoffFixture(initialControl, true);
      try {
        await waitForConnections(panel, connect);
        const surface = connect.mock.calls[0]![0].target;
        if (initialControl) {
          selectSizing(panel, "match");
          await panel.updateComplete;
        }
        const inventoryReads = rpcCalls(request, "environments.list").length;
        const toggle = panel.querySelector<HTMLButtonElement>(
          `button[aria-label="${initialControl ? "Switch to view only" : "Take control"}"]`,
        );
        if (!toggle) {
          throw new Error("expected the desktop control toggle");
        }
        toggle.click();
        await waitForSolid(() => expect(rpcCalls(request, "desktop.observe")).toHaveLength(2));
        expect(previous.disconnect).not.toHaveBeenCalled();
        expect(previous.disableInput).toHaveBeenCalledOnce();
        const pendingMatch =
          sizingMenu(panel).querySelector<HTMLOptionElement>('option[value="match"]');
        expect(sizingMenu(panel).value).toBe(initialControl ? "match" : "fit");
        if (initialControl) {
          expect(pendingMatch).toMatchObject({ selected: true, disabled: true });
        } else {
          expect(pendingMatch).toBeNull();
        }
        gateway.emit("presence", { presence: [] });
        await panel.updateComplete;
        expect(rpcCalls(request, "environments.list")).toHaveLength(inventoryReads);
        observe.resolve({
          transport: "rfb",
          wsPath: "/control",
          control: !initialControl,
          canResize: true,
        });
        await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
        const pending = connect.mock.calls[1]![0];
        expect(connect.mock.calls[1]![0].target).toBe(surface);
        if (handleTiming === "before") {
          replacement.resolve(next);
          await connect.mock.results[1]!.value;
          await panel.updateComplete;
        }
        expect(previous.disconnect).not.toHaveBeenCalled();
        expect(sizingMenu(panel).querySelector('option[value="match"]')).toBeNull();
        const input = panel.querySelector<HTMLTextAreaElement>(".desktop-keyboard-input");
        if (!input) {
          throw new Error("expected the mobile keyboard input");
        }
        const sendKey = () =>
          input.dispatchEvent(
            new KeyboardEvent("keydown", { key: "x", code: "KeyX", bubbles: true }),
          );
        sendKey();
        expect(previous.sendKeyboardEvent).not.toHaveBeenCalled();
        expect(next.sendKeyboardEvent).not.toHaveBeenCalled();
        if (!pending.onConnect) {
          throw new Error("replacement must expose the RFB connected callback");
        }
        pending.onConnect();
        expect(previous.disconnect).toHaveBeenCalledOnce();
        replacement.resolve(next);
        await connect.mock.results[1]!.value;
        await panel.updateComplete;
        gateway.emit("presence", { presence: [] });
        await panel.updateComplete;
        expect(pending.isCurrent()).toBe(true);
        expect(panel.querySelector(".desktop-surface")).toBe(surface);
        expect(canvas.isConnected).toBe(true);
        expect(sizingMenu(panel).value).toBe("fit");
        expect(Boolean(sizingMenu(panel).querySelector('option[value="match"]'))).toBe(
          !initialControl,
        );
        expect(next.disconnect).not.toHaveBeenCalled();
        sendKey();
        expect(next.sendKeyboardEvent).toHaveBeenCalledTimes(initialControl ? 0 : 1);
        expect(previous.sendKeyboardEvent).not.toHaveBeenCalled();
        await unmountPanel(panel);
        expect(next.disconnect).toHaveBeenCalledOnce();
      } finally {
        observe.resolve({ transport: "rfb", wsPath: "/control", control: !initialControl });
        replacement.resolve(next);
        await unmountPanel(panel);
        await panel.updateComplete;
      }
    },
  );

  it.each([
    "observe failure",
    "credentials",
    "security failure",
    "transport failure",
    "transport close code",
    "unclean disconnect",
    "clean disconnect",
    "hide",
    "source change",
    "unmount",
  ] as const)("releases the retained viewer and pending replacement on %s", async (outcome) => {
    const { observe, previous, next, request, connect, panel } = await handoffFixture();
    try {
      await waitForConnections(panel, connect);
      panel.querySelector<HTMLButtonElement>(".desktop-stage__take-control")?.click();
      await waitForSolid(() => expect(rpcCalls(request, "desktop.observe")).toHaveLength(2));
      expect(previous.disconnect).not.toHaveBeenCalled();
      if (outcome === "observe failure" || outcome === "credentials") {
        observe.reject(
          outcome === "credentials"
            ? { details: { code: "DESKTOP_CREDENTIALS_REQUIRED", auth: "vnc-password" } }
            : new Error("observer capacity reached"),
        );
      } else {
        observe.resolve({ transport: "rfb", wsPath: "/control", control: true });
        await waitForConnections(panel, connect, 2);
        const pending = connect.mock.calls[1]![0];
        expect(previous.disconnect).not.toHaveBeenCalled();
        expect(pending?.isCurrent()).toBe(true);
        if (outcome === "security failure") {
          pending?.onSecurityFailure?.({ reason: "authentication rejected" });
          pending?.onDisconnect?.({ clean: false, code: 1008, reason: "authentication rejected" });
        } else if (outcome === "transport failure") {
          pending?.onDisconnect?.({ clean: true, code: 1000, reason: "desktop stream closed" });
        } else if (outcome === "transport close code") {
          pending?.onDisconnect?.({ clean: false, code: 1006, reason: "" });
        } else if (outcome === "unclean disconnect" || outcome === "clean disconnect") {
          pending?.onDisconnect?.({ clean: outcome === "clean disconnect" });
        } else if (outcome === "hide") {
          updatePanel(panel, { presented: false });
        } else if (outcome === "source change") {
          updatePanel(panel, { requestedSource: null });
        } else {
          await unmountPanel(panel);
        }
      }
      await panel.updateComplete;
      const disconnectReasons: Record<string, string> = {
        "transport failure": "desktop stream closed",
        "transport close code": "connection closed with code 1006",
        "unclean disconnect":
          "Reconnect. If it fails again, check the browser console and desktop service logs.",
      };
      const disconnectReason = disconnectReasons[outcome];
      if (outcome === "clean disconnect") {
        expect(panel.querySelector(".desktop-status > div")?.textContent?.trim()).toBe(
          "Desktop disconnected",
        );
      }
      if (disconnectReason) {
        expect(panel.textContent).toContain(`Desktop disconnected: ${disconnectReason}`);
        expect(panel.querySelector(".desktop-status button")?.textContent).toContain("Reconnect");
      }
      await waitForSolid(() => expect(previous.disconnect).toHaveBeenCalledOnce());
      const pending = connect.mock.calls[1]?.[0];
      if (pending) {
        expect(pending.isCurrent()).toBe(false);
        expect(next.disconnect).toHaveBeenCalledOnce();
        pending.onConnect?.();
        await panel.updateComplete;
        expect(previous.disconnect).toHaveBeenCalledOnce();
        expect(next.disconnect).toHaveBeenCalledOnce();
      } else {
        expect(next.disconnect).not.toHaveBeenCalled();
      }
    } finally {
      observe.resolve({ transport: "rfb", wsPath: "/control", control: true });
      await unmountPanel(panel);
      await panel.updateComplete;
    }
  });

  it("keeps a hidden embedded mount dormant even when the standalone dock was open", async () => {
    localStorage.setItem(
      "openclaw.desktopPanel",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const request = vi.fn(async () => ({ environments: [desktopEnvironment] }));
    const panel = await mount(createGatewayClient(request).client, undefined, {
      embedded: true,
      presented: false,
    });
    await panel.updateComplete;

    panel.handleToggleRequest(
      new CustomEvent("openclaw:desktop-toggle", {
        detail: { environmentId: desktopEnvironment.id },
      }),
    );
    await panel.updateComplete;

    expect(request).not.toHaveBeenCalled();
    expect(panel.isConnected).toBe(true);
  });
});

describe("desktop sizing", () => {
  type Connect = DesktopClient["connect"];
  const vncPassword = { auth: "vnc-password", vncPassword: "synthetic" };
  const capabilities = [
    [true, true],
    [true, false],
    [false, true],
    [undefined, true],
  ] as const;
  const sizingCases = [false, true].flatMap((documentMode) =>
    capabilities.map(([canResize, control]) => ({ documentMode, canResize, control })),
  );

  usePanelStorage();

  function observeRequest(
    observed: object | ((params?: { control?: boolean }) => object),
    environments = [desktopEnvironment],
  ) {
    return vi.fn(async (method: string, params?: { control?: boolean; environmentId?: string }) => {
      if (method === "environments.list") {
        return { environments };
      }
      if (method === "environments.status") {
        const environment = environments.find((entry) => entry.id === params?.environmentId);
        if (!environment) {
          throw new Error("Unexpected desktop environment");
        }
        return environment;
      }
      if (method === "desktop.observe") {
        return {
          transport: "rfb",
          wsPath: "/view",
          ...(typeof observed === "function" ? observed(params) : observed),
        };
      }
      throw new Error(`Unexpected desktop RPC: ${method}`);
    });
  }

  function connections(authenticate = false) {
    const handles: ReturnType<typeof createConnectionHandle>[] = [];
    const connect = vi.fn(async (options: Parameters<Connect>[0]) => {
      const handle = createConnectionHandle();
      handles.push(handle);
      if (authenticate) {
        options.onConnect?.();
      }
      return handle;
    });
    return { handles, connect };
  }

  async function mountSized(request: unknown, connect: Connect, options: Partial<Panel> = {}) {
    const panel = await mount(createGatewayClient(request).client, connect, {
      embedded: true,
      presented: true,
      requestedSource: desktopEnvironment.id,
      ...options,
    });
    await waitForConnections(panel, connect);
    return panel;
  }

  it.each([
    ["worker password", { vncPassword: "synthetic" }, { password: "synthetic" }],
    ["explicit VNC", vncPassword, { password: "synthetic" }],
    ["preauthenticated VNC", { ...vncPassword, preauthenticated: true }, undefined],
    ["preauthenticated ARD", { auth: "ard-account", preauthenticated: true }, undefined],
  ] as const)("resolves %s credentials", async (_name, observed, credentials) => {
    const request = observeRequest({ control: false, ...observed });
    const { connect } = connections();
    await mountSized(request, connect);
    expect(connect.mock.calls[0]![0].credentials).toEqual(credentials);
  });

  it.each(sizingCases)("Match authentication: %j", async ({ documentMode, canResize, control }) => {
    const request = observeRequest({ control, canResize });
    const { connect, handles } = connections();
    const panel = await mountSized(request, connect, { documentMode, documentControl: control });

    const handle = handles[0]!;
    const options = connect.mock.calls[0]![0];
    expect(options).toMatchObject({ canResize, viewOnly: !control, sizingMode: "fit" });
    expect(sizingMenu(panel).value).toBe("fit");
    expect(sizingMenu(panel).querySelector('option[value="match"]')).toBeNull();
    options.onConnect?.();
    await panel.updateComplete;
    expect(Boolean(sizingMenu(panel).querySelector('option[value="match"]'))).toBe(
      canResize === true && control,
    );
    selectSizing(panel, "actual");
    expect(handle.setSizingMode).toHaveBeenLastCalledWith("actual");
    selectSizing(panel, "fit");
    expect(handle.setSizingMode).toHaveBeenLastCalledWith("fit");
    if (canResize && control) {
      selectSizing(panel, "match");
      await panel.updateComplete;
      expect(sizingMenu(panel).value).toBe("match");
      expect(handle.setSizingMode).toHaveBeenLastCalledWith("match");
    }
    if (documentMode) {
      expect(panel.querySelectorAll(".desktop-touch-action, .desktop-sizing")).toHaveLength(6);
      const audio = panel.querySelector<HTMLButtonElement>(".desktop-audio-button");
      expect(audio?.getAttribute("aria-label")).toBe("Audio unavailable");
      expect(audio?.disabled).toBe(true);
    }
  });

  it.each(["retry", "demotion", "named demotion", "permission loss", "source change"] as const)(
    "revalidates Match after %s",
    async (transition) => {
      const replacement = { ...desktopEnvironment, id: "worker-desktop-2" };
      let canResize = true;
      const request = observeRequest(
        (params) => ({ control: params?.control, canResize }),
        [desktopEnvironment, replacement],
      );
      const { handles, connect } = connections(true);
      const panel = await mountSized(request, connect, {
        documentMode: true,
        documentControl: true,
      });
      selectSizing(panel, "match");
      await panel.updateComplete;

      const original = connect.mock.calls[0]![0];
      const demoted = transition === "demotion" || transition === "named demotion";
      if (transition === "source change") {
        updatePanel(panel, { requestedSource: replacement.id });
      } else if (demoted) {
        original.onDisconnect?.({
          clean: true,
          code: 4000,
          reason: transition === "named demotion" ? "control-taken:林 🦞" : "control-taken",
        });
      } else {
        canResize = transition !== "permission loss";
        original.onDisconnect?.({ clean: false, code: 1006 });
        await panel.updateComplete;
        clickPanelButton(panel, ".desktop-status button");
      }
      await waitForConnections(panel, connect, 2);
      if (demoted) {
        expect(panel.textContent).toContain(
          transition === "named demotion" ? "林 🦞 took control" : "Another operator took control",
        );
        expectObserve(request, desktopEnvironment.id);
        expect(connect.mock.calls[1]![0].viewOnly).toBe(true);
      }
      expect(handles[0]!.disconnect).toHaveBeenCalledOnce();
      expect(original.isCurrent()).toBe(false);
      expect(connect.mock.calls[1]![0].sizingMode).toBe(transition === "retry" ? "match" : "fit");
      expect(sizingMenu(panel).value).toBe(transition === "retry" ? "match" : "fit");
      expect(Boolean(sizingMenu(panel).querySelector('option[value="match"]'))).toBe(
        transition === "retry" || transition === "source change",
      );
      original.onConnect?.();
      await panel.updateComplete;
      expect(sizingMenu(panel).value).toBe(transition === "retry" ? "match" : "fit");
    },
  );

  it("applies Fit selected during a Match reconnect before authentication enables sizing", async () => {
    const request = observeRequest({ control: true, canResize: true });
    const { handles, connect } = connections();
    const panel = await mountSized(request, connect, { documentMode: true, documentControl: true });
    const initial = connect.mock.calls[0]![0];
    initial.onConnect?.();
    await panel.updateComplete;
    selectSizing(panel, "match");
    initial.onDisconnect?.({ clean: false, code: 1006 });
    await panel.updateComplete;
    clickPanelButton(panel, ".desktop-status button");
    await waitForConnections(panel, connect, 2);
    const pending = connect.mock.calls[1]![0];
    expect(pending.sizingMode).toBe("match");
    expect(sizingMenu(panel).value).toBe("match");
    expect(sizingMenu(panel).selectedOptions[0]?.disabled).toBe(true);
    selectSizing(panel, "fit");
    expect(handles[1]!.setSizingMode).toHaveBeenLastCalledWith("fit");
    expect(handles[0]!.setSizingMode).toHaveBeenLastCalledWith("match");
    pending.onConnect?.();
    await panel.updateComplete;
    expect(sizingMenu(panel).value).toBe("fit");
    expect(handles[1]!.setSizingMode).toHaveBeenLastCalledWith("fit");
  });
});
