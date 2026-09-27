/* @vitest-environment jsdom */

import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment as baseDesktopEnvironment,
  settleTasks,
} from "./desktop-panel.test-support.ts";

const desktopEnvironment = {
  ...baseDesktopEnvironment,
  worker: {
    ...baseDesktopEnvironment.worker,
    attachedSessionIds: [...baseDesktopEnvironment.worker.attachedSessionIds],
    desktopApps: [...baseDesktopEnvironment.worker.desktopApps],
  },
} satisfies EnvironmentSummary;

describe("session desktop connection", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    "preserves human control when showing the same source (explicit=%s)",
    async (explicit) => {
      const request = vi.fn(async (method: string, params?: { control?: boolean }) =>
        method === "environments.status"
          ? desktopEnvironment
          : {
              transport: "rfb",
              wsPath: "/desktop/observe?token=synthetic",
              control: params?.control ?? false,
            },
      );
      const disconnect = vi.fn();
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        options.onConnect?.();
        return createConnectionHandle({ disconnect });
      });
      const onFocusTargetChange = vi.fn();
      const panel = createPanel();
      Object.assign(panel, {
        client: createGatewayClient(request).client,
        available: true,
        embedded: true,
        presented: true,
        sessionKey: "agent:main:preview",
        requestedSource: desktopEnvironment.id,
        desktopClientFactory: () => ({ connect }),
        onFocusTargetChange,
      });
      document.body.append(panel);
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      clickPanelButton(panel, 'button[aria-label="Take control"]');
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
      const controller = connect.mock.calls[1]![0];
      const reads = request.mock.calls.length;
      const disconnects = disconnect.mock.calls.length;
      panel.handleToggleRequest(
        new CustomEvent("openclaw:desktop-toggle", {
          detail: { open: true, ...(explicit ? { environmentId: desktopEnvironment.id } : {}) },
        }),
      );
      await settleTasks();
      expect(request).toHaveBeenCalledTimes(reads);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledTimes(disconnects);
      expect(controller.isCurrent()).toBe(true);
      expect(onFocusTargetChange).toHaveBeenLastCalledWith({
        kind: "desktop",
        control: true,
        ...(explicit ? { source: desktopEnvironment.id } : { session: "agent:main:preview" }),
      });
      expect(panel.renderRoot.textContent).toContain("Agent input is paused");
      clickPanelButton(panel, 'button[aria-label="Switch to view only"]');
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(3));
      expect(request).toHaveBeenLastCalledWith("desktop.observe", {
        source: { kind: "environment", environmentId: desktopEnvironment.id },
        control: false,
      });
    },
  );

  it("preserves an opening source but retries a disconnected one and switches an explicit target", async () => {
    const observed = createDeferred<{ transport: "rfb"; wsPath: string; control: boolean }>();
    let first = true;
    const request = vi.fn(async (method: string, params?: { environmentId?: string }) => {
      if (method === "environments.status") {
        return { ...desktopEnvironment, id: params?.environmentId ?? desktopEnvironment.id };
      }
      if (method === "desktop.observe" && first) {
        first = false;
        return observed.promise;
      }
      return { transport: "rfb", wsPath: "/desktop/observe?token=synthetic", control: false };
    });
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle();
    });
    const panel = createPanel();
    Object.assign(panel, {
      client: createGatewayClient(request).client,
      available: true,
      embedded: true,
      presented: true,
      sessionKey: "agent:main:preview",
      requestedSource: desktopEnvironment.id,
      desktopClientFactory: () => ({ connect }),
    });
    document.body.append(panel);
    await waitForFast(() => expect(first).toBe(false));
    const show = (environmentId: string = desktopEnvironment.id) =>
      panel.handleToggleRequest(
        new CustomEvent("openclaw:desktop-toggle", { detail: { open: true, environmentId } }),
      );
    const reads = request.mock.calls.length;
    show();
    await settleTasks();
    expect(request).toHaveBeenCalledTimes(reads);
    observed.resolve({
      transport: "rfb",
      wsPath: "/desktop/observe?token=synthetic",
      control: false,
    });
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    connect.mock.calls[0]![0].onDisconnect?.({ clean: true });
    await panel.updateComplete;
    show();
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    show("replacement");
    await waitForFast(() => expect(connect).toHaveBeenCalledTimes(3));
    expect(request).toHaveBeenLastCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: "replacement" },
      control: false,
    });
  });

  it.each([false, true])(
    "keeps desktop pending with input disabled until ready (documentMode=%s)",
    async (documentMode) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      let environment: EnvironmentSummary = {
        ...desktopEnvironment,
        status: "starting",
        desktop: false,
      };
      const request = vi.fn(async (method: string) =>
        method === "environments.status"
          ? environment
          : { transport: "rfb", wsPath: "/desktop/observe?token=synthetic", control: false },
      );
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        options.onConnect?.();
        return createConnectionHandle();
      });
      const panel = createPanel();
      Object.assign(panel, {
        client: createGatewayClient(request).client,
        available: true,
        embedded: true,
        documentMode,
        presented: true,
        sessionKey: "agent:main:preview",
        requestedSource: desktopEnvironment.id,
        desktopClientFactory: () => ({ connect }),
      });
      document.body.append(panel);
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("environments.status", {
          environmentId: desktopEnvironment.id,
        }),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(panel.renderRoot.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
      expect(panel.renderRoot.textContent).toContain("Starting your machine");
      const takeControl = [
        ...panel.renderRoot.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Take control"]',
        ),
      ];
      expect(takeControl.length).toBeGreaterThan(0);
      for (const button of takeControl) {
        expect(button.disabled).toBe(true);
        button.click();
      }
      expect(connect).not.toHaveBeenCalled();
      expect(request.mock.calls.some(([method]) => method === "desktop.observe")).toBe(false);

      environment = desktopEnvironment;
      await vi.advanceTimersByTimeAsync(2_000);
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      expect(request).toHaveBeenLastCalledWith("desktop.observe", {
        source: { kind: "environment", environmentId: desktopEnvironment.id },
        control: false,
      });
      const reads = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(request).toHaveBeenCalledTimes(reads);
    },
  );

  it("retires startup reads when the desktop hides and ignores a previous machine's readiness", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const oldReady = createDeferred<EnvironmentSummary>();
    const replacement = { ...desktopEnvironment, id: "replacement-desktop" };
    let oldReads = 0;
    const request = vi.fn(async (method: string, params?: { environmentId?: string }) => {
      if (method === "environments.status") {
        if (params?.environmentId === replacement.id) {
          return replacement;
        }
        oldReads += 1;
        return oldReads === 1
          ? { ...desktopEnvironment, status: "starting", desktop: false }
          : oldReady.promise;
      }
      return { transport: "rfb", wsPath: "/desktop/observe?token=synthetic", control: false };
    });
    const connect = vi.fn(async () => createConnectionHandle());
    const panel = createPanel();
    Object.assign(panel, {
      client: createGatewayClient(request).client,
      available: true,
      embedded: true,
      presented: true,
      sessionKey: "agent:main:preview",
      requestedSource: desktopEnvironment.id,
      desktopClientFactory: () => ({ connect }),
    });
    document.body.append(panel);
    await waitForFast(() => expect(oldReads).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(oldReads).toBe(2);
    panel.presented = false;
    await panel.updateComplete;
    oldReady.resolve(desktopEnvironment);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(oldReads).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    panel.requestedSource = replacement.id;
    panel.presented = true;
    await panel.updateComplete;
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    expect(request).toHaveBeenLastCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: replacement.id },
      control: false,
    });
  });

  it("passes the worker observe password to the desktop client without an auth discriminator", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return { environments: [desktopEnvironment] };
      }
      return {
        transport: "rfb",
        wsPath: "/desktop/observe?token=worker",
        expiresAtMs: 60_000,
        control: false,
        vncPassword: "synthetic-worker-password",
      };
    });
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle();
    });
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.documentMode = true;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".desktop-environment button")).not.toBeNull(),
    );
    clickPanelButton(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    expect(connect.mock.calls[0]?.[0].credentials).toEqual({
      password: "synthetic-worker-password",
    });
  });

  it.each(["embedded", "session document", "source document"] as const)(
    "opens the %s without waiting for global inventory and retries its status",
    async (presentation) => {
      const pending = createDeferred<typeof desktopEnvironment>();
      let environment = pending.promise;
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.describe") {
          return {
            session: {
              key: "agent:main:cloud",
              placement: { state: "active", environmentId: desktopEnvironment.id },
            },
          };
        }
        if (method === "environments.status") {
          return environment;
        }
        if (method === "desktop.observe") {
          return {
            transport: "rfb",
            wsPath: "/desktop/observe?token=session",
            expiresAtMs: 60_000,
            control: false,
          };
        }
        throw new Error("Global inventory unavailable");
      });
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        options.onConnect?.();
        return createConnectionHandle();
      });
      const panel = createPanel();
      panel.client = createGatewayClient(request).client;
      panel.available = true;
      panel.embedded = presentation === "embedded";
      panel.presented = true;
      panel.documentMode = presentation !== "embedded";
      panel.sessionKey = presentation === "source document" ? null : "agent:main:cloud";
      panel.requestedSource = presentation === "session document" ? null : desktopEnvironment.id;
      panel.desktopClientFactory = () => ({ connect });
      document.body.append(panel);

      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("environments.status", {
          environmentId: desktopEnvironment.id,
        }),
      );
      expect(
        request.mock.calls.filter(([method]) => method === "environments.status"),
      ).toHaveLength(1);
      expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toHaveLength(
        presentation === "session document" ? 1 : 0,
      );
      if (panel.embedded) {
        expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
      }
      expect(panel.renderRoot.querySelectorAll(".desktop-environment")).toHaveLength(0);
      expect(connect).not.toHaveBeenCalled();

      pending.reject(new Error("Desktop is still starting"));
      await waitForFast(() =>
        expect(panel.renderRoot.textContent).toContain("Desktop is still starting"),
      );
      expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
      environment = Promise.resolve(desktopEnvironment);
      clickPanelButton(panel, ".desktop-status button");
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      expect(request).toHaveBeenLastCalledWith("desktop.observe", {
        source: { kind: "environment", environmentId: desktopEnvironment.id },
        control: false,
      });
      expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
      expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
    },
  );

  it.each(["success", "failure", "lookup failure"] as const)(
    "keeps the newest target owner through a late status and %s",
    async (outcome) => {
      const previous = createDeferred<typeof desktopEnvironment>();
      const nextSession = createDeferred<unknown>();
      const replacement = { ...desktopEnvironment, id: "worker-replacement" };
      const sessionKey = "agent:main:target-race";
      let session: Promise<unknown> = Promise.resolve({
        session: {
          key: sessionKey,
          placement: { state: "active", environmentId: desktopEnvironment.id },
        },
      });
      const request = vi.fn(async (method: string, params?: { environmentId?: string }) => {
        if (method === "sessions.describe") {
          return session;
        }
        if (method === "environments.status") {
          return params?.environmentId === replacement.id ? replacement : previous.promise;
        }
        if (method === "desktop.observe") {
          return { transport: "rfb", wsPath: "/desktop/observe?token=current", control: false };
        }
        throw new Error("Global inventory must not participate");
      });
      const gateway = createGatewayClient(request);
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        options.onConnect?.();
        return createConnectionHandle();
      });
      const panel = createPanel();
      panel.client = gateway.client;
      panel.available = true;
      panel.documentMode = true;
      panel.sessionKey = sessionKey;
      panel.desktopClientFactory = () => ({ connect });
      document.body.append(panel);
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("environments.status", {
          environmentId: desktopEnvironment.id,
        }),
      );
      session = nextSession.promise;
      gateway.emit("sessions.changed", { sessionKey, reason: "placement" });
      await waitForFast(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.describe"),
        ).toHaveLength(2),
      );
      if (outcome === "failure") {
        previous.reject(new Error("Retired target unavailable"));
      } else {
        previous.resolve(desktopEnvironment);
      }
      await settleTasks();
      expect(connect).not.toHaveBeenCalled();
      expect(panel.renderRoot.textContent).not.toContain("Retired target unavailable");
      if (outcome === "lookup failure") {
        nextSession.reject(new Error("Current target lookup unavailable"));
        await waitForFast(() =>
          expect(panel.renderRoot.textContent).toContain("Current target lookup unavailable"),
        );
        expect(panel.renderRoot.querySelector(".desktop-status button")?.textContent).toContain(
          "Retry",
        );
        expect(connect).not.toHaveBeenCalled();
        expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
        return;
      }
      nextSession.resolve({
        session: { key: sessionKey, placement: { state: "active", environmentId: replacement.id } },
      });
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      expect(request).toHaveBeenLastCalledWith("desktop.observe", {
        source: { kind: "environment", environmentId: replacement.id },
        control: false,
      });
      expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toHaveLength(
        2,
      );
      expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
    },
  );

  it("retries a failed session lookup without treating it as an unavailable target", async () => {
    const sessionKey = "agent:main:lookup-retry";
    let failing = true;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        if (failing) {
          throw new Error("Session lookup unavailable");
        }
        return {
          session: {
            key: sessionKey,
            placement: { state: "active", environmentId: desktopEnvironment.id },
          },
        };
      }
      if (method === "environments.status") {
        return desktopEnvironment;
      }
      if (method === "desktop.observe") {
        return { transport: "rfb", wsPath: "/desktop/observe?token=current", control: false };
      }
      throw new Error("Global inventory must not participate");
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
    panel.sessionKey = sessionKey;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);
    await waitForFast(() =>
      expect(panel.renderRoot.textContent).toContain("Session lookup unavailable"),
    );
    expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
    failing = false;
    clickPanelButton(panel, ".desktop-status button");
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    failing = true;
    gateway.emit("sessions.changed", { sessionKey, reason: "placement" });
    await settleTasks();
    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
  });
});
