/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DesktopClient, DesktopConnectionHandle } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment,
  settleTasks,
} from "./desktop-panel.test-support.ts";

describe("embedded desktop panel presentation", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it.each([
    { reason: "control-taken:Alex Rivera", notice: "Alex Rivera took control" },
    { reason: "control-taken:林 🦞", notice: "林 🦞 took control" },
    { reason: "control-taken:<b>Alex</b>", notice: "<b>Alex</b> took control" },
    { reason: "control-taken", notice: "Another operator took control" },
  ])("identifies a takeover ($reason) and reconnects view-only", async ({ reason, notice }) => {
    const request = vi.fn(async (method: string, params?: { control?: boolean }) => {
      if (method === "environments.list") {
        return { environments: [desktopEnvironment] };
      }
      if (method === "environments.status") {
        return desktopEnvironment;
      }
      return { transport: "rfb", wsPath: "/desktop/observe?token=test", control: params?.control };
    });
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle();
    });
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.documentMode = true;
    panel.documentControl = true;
    panel.embedded = true;
    panel.presented = true;
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    await settleTasks();
    connect.mock.calls[0]?.[0].onDisconnect?.({ clean: true, code: 4000, reason });

    await waitForFast(() => expect(panel.renderRoot.textContent).toContain(notice));
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: desktopEnvironment.id },
      control: false,
    });
    expect(connect.mock.calls[1]?.[0].viewOnly).toBe(true);
  });

  it("follows the session desktop and retires its connection before resolving a new placement", async () => {
    const replacement = { ...desktopEnvironment, id: "worker-desktop-2" };
    let refresh: Promise<void> | undefined;
    const request = vi.fn(async (method: string, params?: { environmentId?: string }) => {
      if (method === "environments.status") {
        await refresh;
        return params?.environmentId === replacement.id ? replacement : desktopEnvironment;
      }
      return {
        transport: "rfb",
        wsPath: "/desktop/observe?token=session",
        expiresAtMs: 60_000,
        control: false,
      };
    });
    const disconnect = vi.fn();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle({ disconnect });
    });
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.sessionKey = "agent:main:cloud";
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("environments.status", {
      environmentId: desktopEnvironment.id,
    });
    expect(request).toHaveBeenCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: desktopEnvironment.id },
      control: false,
    });

    const nextInventory = createDeferred();
    refresh = nextInventory.promise;
    panel.requestedSource = replacement.id;
    await panel.updateComplete;
    expect(disconnect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    nextInventory.resolve();
    refresh = undefined;
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenLastCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: replacement.id },
      control: false,
    });

    panel.requestedSource = null;
    await panel.updateComplete;
    await settleTasks();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.some(([method]) => method === "sessions.describe")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
    expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
    expect(panel.renderRoot.textContent).toContain("The requested desktop is unavailable");
  });

  it.each(
    (["session", "source", "embedded", "picker", "floating"] as const).flatMap((presentation) =>
      [
        {
          event: "presence",
          payload: { presence: [{ deviceId: "workstation", roles: ["node"], reason: "connect" }] },
        },
        {
          event: "node.pair.resolved",
          payload: { nodeId: "workstation", requestId: "surface", decision: "approved", ts: 1 },
        },
        { event: "node.runnerInventory.changed", payload: { nodeId: "workstation" } },
      ].map(({ event, payload }) => ({ presentation, event, payload })),
    ),
  )(
    "discovers a late node on $event in the $presentation presenter without retaining credentials",
    async ({ presentation, event, payload }) => {
      const node = { id: "node:workstation", type: "node", status: "available", desktop: true };
      const sessionKey = "agent:main:desktop";
      const picker = presentation === "picker" || presentation === "floating";
      let online = true;
      const request = vi.fn(
        async (
          method: string,
          params?: { credentials?: { username: string; password: string } },
        ) => {
          if (method === "environments.list") {
            return { environments: online ? [node] : [] };
          }
          if (method === "environments.status") {
            return { ...node, desktop: online };
          }
          if (method === "sessions.describe") {
            return { session: { key: sessionKey, execNode: "workstation" } };
          }
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
      const panel = createPanel();
      panel.client = gateway.client;
      panel.available = true;
      panel.documentMode = presentation !== "embedded" && presentation !== "floating";
      panel.embedded = presentation === "embedded";
      panel.presented = true;
      panel.sessionKey = presentation === "session" ? sessionKey : null;
      panel.requestedSource = presentation === "source" || panel.embedded ? node.id : null;
      panel.desktopClientFactory = () => ({ connect });
      document.body.append(panel);
      await panel.updateComplete;
      if (presentation === "floating") {
        window.dispatchEvent(
          new CustomEvent("openclaw:desktop-toggle", { detail: { open: true } }),
        );
      }
      if (picker) {
        await waitForFast(() =>
          expect(panel.renderRoot.querySelector(".desktop-environment")).not.toBeNull(),
        );
        clickPanelButton(panel);
      }
      const credentialForm = (stage: "initial" | "reconnected") => {
        const form = panel.renderRoot.querySelector<HTMLFormElement>("form");
        const username = form?.querySelector<HTMLInputElement>('input[name="username"]');
        const password = form?.querySelector<HTMLInputElement>('input[name="password"]');
        if (!form || !username || !password) {
          throw new Error(`expected the ${stage} ARD credential form`);
        }
        return { form, username, password };
      };
      const initial = await waitForFast(() => credentialForm("initial"));
      initial.username.value = "operator";
      initial.password.value = "synthetic";
      initial.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());

      panel.available = false;
      panel.client = null;
      await panel.updateComplete;
      expect(disconnect).toHaveBeenCalledOnce();
      online = false;
      panel.client = gateway.client;
      panel.available = true;
      await panel.updateComplete;
      await settleTasks();
      expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull();
      expect(panel.renderRoot.querySelectorAll(".desktop-environment")).toHaveLength(0);
      const observations = () =>
        request.mock.calls.filter(([method]) => method === "desktop.observe");
      expect(observations()).toHaveLength(2);

      // Connection precedes approval: the first inventory still has no usable desktop.
      gateway.emit("presence", {
        presence: [{ deviceId: "workstation", roles: ["node"], reason: "connect" }],
      });
      await settleTasks();
      expect(panel.renderRoot.querySelectorAll(".desktop-environment")).toHaveLength(0);
      expect(observations()).toHaveLength(2);
      online = true;
      gateway.emit(event, payload);
      if (picker) {
        await waitForFast(() =>
          expect(
            panel.renderRoot.querySelector(".desktop-environment")?.textContent ?? "",
          ).toContain(node.id),
        );
        expect(observations()).toHaveLength(2);
        clickPanelButton(panel);
      }
      const reconnected = await waitForFast(() => credentialForm("reconnected"));
      expect(observations().at(-1)?.[1]).toEqual({
        source: { kind: "node", nodeId: "workstation" },
        control: false,
      });
      expect(reconnected.username.value).toBe("");
      expect(reconnected.password.value).toBe("");
      gateway.emit(event, payload);
      await settleTasks();
      expect(observations()).toHaveLength(3);
      expect(connect).toHaveBeenCalledOnce();
    },
  );

  it("discovers a node that arrives before an older empty inventory response finishes", async () => {
    const empty = createDeferred<{ environments: [] }>();
    const node = { id: "node:workstation", type: "node", status: "available", desktop: true };
    let inventory: Promise<{ environments: (typeof node)[] }> = empty.promise;
    const request = vi.fn(async (method: string) => {
      if (method === "environments.status") {
        return (await inventory).environments[0] ?? { ...node, desktop: false };
      }
      if (method === "environments.list") {
        return inventory;
      }
      return { transport: "rfb", wsPath: "/desktop/observe?token=synthetic", control: false };
    });
    const gateway = createGatewayClient(request);
    const disconnect = vi.fn();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle({ disconnect });
    });
    const panel = createPanel();
    panel.client = gateway.client;
    panel.available = true;
    panel.documentMode = true;
    panel.requestedSource = node.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    try {
      await panel.updateComplete;
      expect(request).toHaveBeenCalledWith("environments.status", { environmentId: node.id });
      inventory = Promise.resolve({ environments: [node] });
      gateway.emit("presence", {
        presence: [{ deviceId: "workstation", roles: ["node"], reason: "connect" }],
      });
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      empty.resolve({ environments: [] });
      await settleTasks();
      expect(connect.mock.calls[0]?.[0].isCurrent()).toBe(true);
      expect(disconnect).not.toHaveBeenCalled();
      expect(panel.renderRoot.querySelector(".desktop-surface")).not.toBeNull();
    } finally {
      empty.resolve({ environments: [] });
      panel.remove();
      await settleTasks();
    }
  });

  it("ignores a session lookup superseded by a renewed target refresh", async () => {
    const node = { id: "node:workstation", type: "node", status: "available", desktop: true };
    const session = { key: "agent:main:desktop", execNode: "workstation" };
    const oldSession = createDeferred<unknown>();
    const nextInventory = createDeferred<{ environments: (typeof node)[] }>();
    let inventory: Promise<{ environments: (typeof node)[] }> = Promise.resolve({
      environments: [],
    });
    let sessionRead: Promise<unknown> = Promise.resolve({ session });
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return inventory;
      }
      if (method === "environments.status") {
        return (await inventory).environments[0] ?? { ...node, desktop: false };
      }
      if (method === "sessions.describe") {
        return sessionRead;
      }
      return { transport: "rfb", wsPath: "/desktop/observe?token=synthetic", control: false };
    });
    const gateway = createGatewayClient(request);
    const disconnect = vi.fn();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle({ disconnect });
    });
    const panel = createPanel();
    panel.client = gateway.client;
    panel.available = true;
    panel.documentMode = true;
    panel.sessionKey = session.key;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    const startOldSessionRead = async () => {
      const reads = request.mock.calls.filter(([method]) => method === "sessions.describe").length;
      sessionRead = oldSession.promise;
      gateway.emit("sessions.changed", { sessionKey: session.key });
      await waitForFast(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.describe"),
        ).toHaveLength(reads + 1),
      );
      sessionRead = Promise.resolve({ session });
    };
    const retired = { session: { key: session.key, placement: { state: "reclaimed" } } };
    try {
      await panel.updateComplete;
      await settleTasks();
      expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull();
      await startOldSessionRead();
      inventory = nextInventory.promise;
      gateway.emit("presence", {
        presence: [{ deviceId: "workstation", roles: ["node"], reason: "connect" }],
      });
      oldSession.resolve(retired);
      await settleTasks();
      nextInventory.resolve({ environments: [node] });
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      oldSession.resolve(retired);
      await settleTasks();
      expect(connect.mock.calls[0]?.[0].isCurrent()).toBe(true);
      expect(disconnect).not.toHaveBeenCalled();
      expect(panel.renderRoot.querySelector(".desktop-surface")).not.toBeNull();
    } finally {
      oldSession.resolve(retired);
      nextInventory.resolve({ environments: [] });
      panel.remove();
      await settleTasks();
    }
  });

  it.each(["hide", "replace", "unmount"] as const)(
    "ignores queued presence after the picker is retired by %s",
    async (action) => {
      const request = vi.fn(async () => ({ environments: [] }));
      const replacementRequest = vi.fn(async () => ({ environments: [] }));
      const gateway = createGatewayClient(request);
      const replacement = createGatewayClient(replacementRequest);
      const panel = createPanel();
      panel.client = gateway.client;
      panel.available = true;
      panel.embedded = true;
      panel.presented = true;
      document.body.append(panel);
      await panel.updateComplete;
      await settleTasks();
      const reads = request.mock.calls.length;
      if (action === "hide") {
        panel.presented = false;
      } else if (action === "replace") {
        panel.client = replacement.client;
      } else {
        panel.remove();
      }
      gateway.emit("presence", { presence: [] });
      expect(request).toHaveBeenCalledTimes(reads);
      expect(replacementRequest).not.toHaveBeenCalled();
      await panel.updateComplete;
      await settleTasks();
      gateway.emit("presence", { presence: [] });
      expect(request).toHaveBeenCalledTimes(reads);
      panel.remove();
      const replacementReads = replacementRequest.mock.calls.length;
      replacement.emit("presence", { presence: [] });
      await settleTasks();
      expect(replacementRequest).toHaveBeenCalledTimes(replacementReads);
    },
  );

  it("keeps a standalone picker selection and control across presence updates", async () => {
    const selected = { ...desktopEnvironment, id: "worker-manual" };
    let environments = [desktopEnvironment, selected];
    const request = vi.fn(
      async (method: string, params?: { control?: boolean; environmentId?: string }) =>
        method === "environments.list"
          ? { environments }
          : method === "environments.status"
            ? environments.find((environment) => environment.id === params?.environmentId)
            : {
                transport: "rfb",
                wsPath: "/desktop/observe?token=synthetic",
                control: params?.control ?? false,
              },
    );
    const gateway = createGatewayClient(request);
    const disconnect = vi.fn();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle({ disconnect });
    });
    const panel = createPanel();
    panel.client = gateway.client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.requestedSource = desktopEnvironment.id;
    const onFocusTargetChange = vi.fn();
    panel.onFocusTargetChange = onFocusTargetChange;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    clickPanelButton(panel, 'button[aria-label="Disconnect"]');
    await panel.updateComplete;
    environments = [];
    gateway.emit("presence", { presence: [] });
    await waitForFast(() =>
      expect(panel.renderRoot.querySelectorAll(".desktop-environment")).toHaveLength(0),
    );
    expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull();
    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "sessions.describe")).toBe(false);

    environments = [selected, desktopEnvironment];
    gateway.emit("presence", { presence: [] });
    await waitForFast(() =>
      expect(panel.renderRoot.querySelectorAll(".desktop-environment")).toHaveLength(2),
    );
    clickPanelButton(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    clickPanelButton(panel, 'button[aria-label="Take control"]');
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(3));
    const selectedConnection = connect.mock.calls.at(-1)?.[0];
    expect(selectedConnection?.viewOnly).toBe(false);
    expect(request).toHaveBeenLastCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: selected.id },
      control: true,
    });
    await settleTasks();
    const selectedFocus = { kind: "desktop", source: selected.id, control: true };
    expect(onFocusTargetChange).toHaveBeenLastCalledWith(selectedFocus);

    environments = [desktopEnvironment];
    gateway.emit("presence", { presence: [] });
    await settleTasks();
    expect({
      connected: selectedConnection?.isCurrent(),
      connections: connect.mock.calls.length,
      disconnects: disconnect.mock.calls.length,
      focus: onFocusTargetChange.mock.calls.at(-1)?.[0],
    }).toEqual({ connected: true, connections: 3, disconnects: 2, focus: selectedFocus });
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
      const request = vi.fn(
        async (method: string, params?: { control?: boolean; environmentId?: string }) => {
          if (method === "environments.list") {
            return { environments: [selected, desktopEnvironment] };
          }
          if (method === "environments.status") {
            return params?.environmentId === selected.id ? selected : desktopEnvironment;
          }
          if (method === "sessions.describe") {
            return sessionRead ?? { session: active };
          }
          return {
            transport: "rfb",
            wsPath: "/desktop/observe?token=focused",
            expiresAtMs: 60_000,
            control: params?.control ?? false,
          };
        },
      );
      const disconnect = vi.fn();
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        options.onConnect?.();
        return createConnectionHandle({ disconnect });
      });
      const gateway = createGatewayClient(request);
      const panel = createPanel();
      panel.client = gateway.client;
      panel.available = true;
      panel.documentMode = true;
      panel.sessionKey = sessionKey;
      const onFocusTargetChange = vi.fn();
      panel.onFocusTargetChange = onFocusTargetChange;
      panel.desktopClientFactory = () => ({ connect });
      document.body.append(panel);
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      const descriptions = () =>
        request.mock.calls.filter(([method]) => method === "sessions.describe");
      const changed = (key = sessionKey) => gateway.emit("sessions.changed", { sessionKey: key });

      changed("agent:main:unrelated");
      await settleTasks();
      expect(descriptions()).toHaveLength(1);
      changed();
      await waitForFast(() => expect(descriptions()).toHaveLength(2));
      await settleTasks();
      expect(disconnect).not.toHaveBeenCalled();

      const pending = createDeferred<unknown>();
      sessionRead = pending.promise;
      changed();
      await waitForFast(() => expect(descriptions()).toHaveLength(3));
      clickPanelButton(panel, 'button[aria-label="Take control"]');
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
      pending.resolve({ session: reclaimed });
      await waitForFast(() =>
        expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull(),
      );
      expect(disconnect).toHaveBeenCalledTimes(2);

      sessionRead = undefined;
      changed();
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(3));
      const stale = createDeferred<unknown>();
      sessionRead = stale.promise;
      changed();
      await waitForFast(() => expect(descriptions()).toHaveLength(5));
      sessionRead = Promise.resolve({ session: reclaimed });
      changed();
      await waitForFast(() =>
        expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull(),
      );
      stale.resolve({ session: active });
      await settleTasks();
      expect(connect).toHaveBeenCalledTimes(3);
      const lookup = createDeferred<unknown>();
      sessionRead = lookup.promise;
      const startLookup = async () => {
        const count = descriptions().length;
        changed();
        await waitForFast(() => expect(descriptions()).toHaveLength(count + 1));
      };
      if (lookupTiming === "before") {
        await startLookup();
      }
      clickPanelButton(panel);
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(4));
      clickPanelButton(panel, 'button[aria-label="Take control"]');
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(5));
      const chosenConnection = connect.mock.calls.at(-1)?.[0];
      expect(chosenConnection?.viewOnly).toBe(false);
      if (lookupTiming === "after") {
        await startLookup();
      }
      lookup.resolve({ session: active });
      await settleTasks();
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
      panel.sessionKey = null;
      panel.requestedSource = desktopEnvironment.id;
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(connections + 1));
      panel.requestedSource = selected.id;
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(connections + 2));
      expect(request).toHaveBeenLastCalledWith("desktop.observe", {
        source: { kind: "environment", environmentId: selected.id },
        control: false,
      });
      expect(onFocusTargetChange).toHaveBeenLastCalledWith({
        kind: "desktop",
        source: selected.id,
        control: false,
      });
      panel.remove();
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
      const observe = createDeferred<unknown>();
      const replacement = createDeferred<DesktopConnectionHandle>();
      const previous = createConnectionHandle();
      const next = createConnectionHandle();
      let pending: Parameters<DesktopClient["connect"]>[0] | undefined;
      const request = vi.fn(async (method: string, params?: { control?: boolean }) => {
        if (method === "environments.list") {
          return { environments: [desktopEnvironment] };
        }
        if (method === "environments.status") {
          return desktopEnvironment;
        }
        if (params?.control !== initialControl) {
          return observe.promise;
        }
        return { transport: "rfb", wsPath: "/view", control: initialControl };
      });
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        if (options.viewOnly !== !initialControl) {
          pending = options;
          return replacement.promise;
        }
        options.onConnect?.();
        return previous;
      });
      const gateway = createGatewayClient(request);
      const panel = createPanel();
      panel.client = gateway.client;
      panel.available = true;
      panel.documentMode = true;
      panel.documentControl = initialControl;
      panel.embedded = true;
      panel.presented = true;
      panel.requestedSource = desktopEnvironment.id;
      panel.desktopClientFactory = () => ({ connect });
      document.body.append(panel);
      try {
        await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
        await settleTasks();
        const inventoryReads = request.mock.calls.filter(
          ([method]) => method === "environments.list",
        ).length;
        const toggle = panel.renderRoot.querySelector<HTMLButtonElement>(
          `button[aria-label="${initialControl ? "Switch to view only" : "Take control"}"]`,
        );
        if (!toggle) {
          throw new Error("expected the desktop control toggle");
        }
        toggle.click();
        await waitForFast(() =>
          expect(
            request.mock.calls.filter(([method]) => method === "desktop.observe"),
          ).toHaveLength(2),
        );
        expect(previous.disconnect).not.toHaveBeenCalled();
        expect(previous.disableInput).toHaveBeenCalledOnce();
        gateway.emit("presence", { presence: [] });
        await settleTasks();
        expect(
          request.mock.calls.filter(([method]) => method === "environments.list"),
        ).toHaveLength(inventoryReads);
        observe.resolve({ transport: "rfb", wsPath: "/control", control: !initialControl });
        await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
        if (handleTiming === "before") {
          replacement.resolve(next);
          await settleTasks();
        }
        expect(previous.disconnect).not.toHaveBeenCalled();
        const input =
          panel.renderRoot.querySelector<HTMLTextAreaElement>(".desktop-keyboard-input");
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
        if (!pending?.onConnect) {
          throw new Error("replacement must expose the RFB connected callback");
        }
        pending.onConnect();
        expect(previous.disconnect).toHaveBeenCalledOnce();
        replacement.resolve(next);
        await settleTasks();
        gateway.emit("presence", { presence: [] });
        await settleTasks();
        expect(pending.isCurrent()).toBe(true);
        expect(next.disconnect).not.toHaveBeenCalled();
        sendKey();
        expect(next.sendKeyboardEvent).toHaveBeenCalledTimes(initialControl ? 0 : 1);
        expect(previous.sendKeyboardEvent).not.toHaveBeenCalled();
        panel.remove();
        expect(next.disconnect).toHaveBeenCalledOnce();
      } finally {
        observe.resolve({ transport: "rfb", wsPath: "/control", control: !initialControl });
        replacement.resolve(next);
        panel.remove();
        await settleTasks();
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
    const observe = createDeferred<unknown>();
    const previous = createConnectionHandle();
    const next = createConnectionHandle();
    let pending: Parameters<DesktopClient["connect"]>[0] | undefined;
    const request = vi.fn(async (method: string, params?: { control?: boolean }) => {
      if (method === "environments.list") {
        return { environments: [desktopEnvironment] };
      }
      if (method === "environments.status") {
        return desktopEnvironment;
      }
      return params?.control
        ? observe.promise
        : { transport: "rfb", wsPath: "/view", control: false };
    });
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      if (!options.viewOnly) {
        pending = options;
        return next;
      }
      options.onConnect?.();
      return previous;
    });
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    try {
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      await settleTasks();
      panel.renderRoot.querySelector<HTMLButtonElement>(".desktop-stage__take-control")?.click();
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(
          2,
        ),
      );
      expect(previous.disconnect).not.toHaveBeenCalled();
      if (outcome === "observe failure" || outcome === "credentials") {
        observe.reject(
          outcome === "credentials"
            ? { details: { code: "DESKTOP_CREDENTIALS_REQUIRED", auth: "vnc-password" } }
            : new Error("observer capacity reached"),
        );
      } else {
        observe.resolve({ transport: "rfb", wsPath: "/control", control: true });
        await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
        await settleTasks();
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
          panel.presented = false;
        } else if (outcome === "source change") {
          panel.requestedSource = null;
        } else {
          panel.remove();
        }
      }
      await settleTasks();
      const disconnectReasons: Record<string, string> = {
        "transport failure": "desktop stream closed",
        "transport close code": "connection closed with code 1006",
        "unclean disconnect":
          "Reconnect. If it fails again, check the browser console and desktop service logs.",
        "clean disconnect": "unknown reason",
      };
      const disconnectReason = disconnectReasons[outcome];
      if (disconnectReason) {
        expect(panel.renderRoot.textContent).toContain(`Desktop disconnected: ${disconnectReason}`);
        expect(panel.renderRoot.querySelector(".desktop-status button")?.textContent).toContain(
          "Reconnect",
        );
      }
      expect(previous.disconnect).toHaveBeenCalledOnce();
      if (pending) {
        expect(pending.isCurrent()).toBe(false);
        expect(next.disconnect).toHaveBeenCalledOnce();
        pending.onConnect?.();
        await settleTasks();
        expect(previous.disconnect).toHaveBeenCalledOnce();
        expect(next.disconnect).toHaveBeenCalledOnce();
      } else {
        expect(next.disconnect).not.toHaveBeenCalled();
      }
    } finally {
      observe.resolve({ transport: "rfb", wsPath: "/control", control: true });
      panel.remove();
      await settleTasks();
    }
  });

  it("keeps a hidden embedded mount dormant even when the standalone dock was open", async () => {
    localStorage.setItem(
      "openclaw.desktopPanel",
      JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
    );
    const request = vi.fn(async () => ({ environments: [desktopEnvironment] }));
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = false;
    document.body.append(panel);
    await panel.updateComplete;
    await settleTasks();

    panel.handleToggleRequest(
      new CustomEvent("openclaw:desktop-toggle", {
        detail: { environmentId: desktopEnvironment.id },
      }),
    );
    await settleTasks();

    expect(request).not.toHaveBeenCalled();
    expect(panel.isConnected).toBe(true);
  });

  it("disconnects a hidden retained connection and reactivates at the picker", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return { environments: [desktopEnvironment] };
      }
      return {
        transport: "rfb",
        wsPath: "/desktop/observe?token=unit",
        expiresAtMs: 60_000,
        control: false,
      };
    });
    const disconnect = vi.fn();
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle({ disconnect });
    });
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() => {
      expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(
        1,
      );
    });
    clickPanelButton(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());

    panel.presented = false;
    await panel.updateComplete;

    expect(disconnect).toHaveBeenCalledOnce();
    expect(panel.isConnected).toBe(true);

    panel.presented = true;
    await waitForFast(() => {
      expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(
        2,
      );
    });

    expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1);
    expect(connect).toHaveBeenCalledOnce();
    expect(panel.renderRoot.querySelector(".desktop-picker")).not.toBeNull();
  });

  it("invalidates a pending observe before it can connect", async () => {
    let resolveObserve: (value: unknown) => void = (_value) => {
      throw new Error("observe request was not started");
    };
    const observe = new Promise<unknown>((resolve) => {
      resolveObserve = resolve;
    });
    const request = vi.fn((method: string) => {
      if (method === "environments.list") {
        return Promise.resolve({ environments: [desktopEnvironment] });
      }
      return observe;
    });
    const connect = vi.fn(async () => createConnectionHandle());
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() => {
      expect(request.mock.calls.filter(([method]) => method === "environments.list")).toHaveLength(
        1,
      );
    });
    clickPanelButton(panel);
    await waitForFast(() => {
      expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1);
    });

    panel.presented = false;
    await panel.updateComplete;
    resolveObserve({
      transport: "rfb",
      wsPath: "/desktop/observe?token=stale",
      expiresAtMs: 60_000,
      control: false,
    });
    await settleTasks();

    expect(connect).not.toHaveBeenCalled();
    expect(panel.isConnected).toBe(true);
  });
});
