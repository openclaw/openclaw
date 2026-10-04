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

  function mount(
    request: (
      method: string,
      params?: { control?: boolean; environmentId?: string },
    ) => Promise<unknown>,
    options: Partial<
      Pick<
        ReturnType<typeof createPanel>,
        "embedded" | "documentMode" | "sessionKey" | "requestedSource" | "onFocusTargetChange"
      >
    > = {},
    authenticate = true,
  ) {
    const gateway = createGatewayClient(request);
    const disconnect = vi.fn();
    const connect = vi.fn(async (connectionOptions: Parameters<DesktopClient["connect"]>[0]) => {
      if (authenticate) {
        connectionOptions.onConnect?.();
      }
      return createConnectionHandle({ disconnect });
    });
    const panel = createPanel();
    Object.assign(panel, {
      client: gateway.client,
      available: true,
      embedded: true,
      presented: true,
      sessionKey: "agent:main:preview",
      requestedSource: desktopEnvironment.id,
      desktopClientFactory: () => ({ connect }),
      ...options,
    });
    document.body.append(panel);
    return { panel, gateway, connect, disconnect };
  }

  it.each([
    { phase: "connected", explicit: false },
    { phase: "connected", explicit: true },
    { phase: "opening", explicit: true },
  ])("preserves the $phase source on show (explicit=$explicit)", async ({ phase, explicit }) => {
    const observed = createDeferred<{ transport: "rfb"; wsPath: string; control: boolean }>();
    let first = true;
    const request = vi.fn(
      async (method: string, params?: { control?: boolean; environmentId?: string }) => {
        if (method === "environments.status") {
          return { ...desktopEnvironment, id: params?.environmentId ?? desktopEnvironment.id };
        }
        if (method === "desktop.observe" && first) {
          first = false;
          if (phase === "opening") {
            return observed.promise;
          }
        }
        return {
          transport: "rfb",
          wsPath: "/desktop/observe?token=synthetic",
          control: params?.control ?? false,
        };
      },
    );
    const onFocusTargetChange = vi.fn();
    const { panel, connect, disconnect } = mount(request, { onFocusTargetChange });
    if (phase === "opening") {
      await waitForFast(() => expect(first).toBe(false));
    } else {
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      clickPanelButton(panel, 'button[aria-label="Take control"]');
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(2));
    }
    const show = (environmentId: string = desktopEnvironment.id) =>
      panel.handleToggleRequest(
        new CustomEvent("openclaw:desktop-toggle", {
          detail: { open: true, ...(explicit ? { environmentId } : {}) },
        }),
      );
    const reads = request.mock.calls.length;
    const disconnects = disconnect.mock.calls.length;
    show();
    await settleTasks();
    expect(request).toHaveBeenCalledTimes(reads);
    if (phase === "opening") {
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
    } else {
      expect(connect).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledTimes(disconnects);
      expect(connect.mock.calls[1]![0].isCurrent()).toBe(true);
      expect(onFocusTargetChange).toHaveBeenLastCalledWith({
        kind: "desktop",
        control: true,
        ...(explicit ? { source: desktopEnvironment.id } : { session: "agent:main:preview" }),
      });
      expect(panel.renderRoot.textContent).not.toContain("Agent input is paused");
      clickPanelButton(panel, 'button[aria-label="Switch to view only"]');
      await waitForFast(() => expect(connect).toHaveBeenCalledTimes(3));
      expect(request).toHaveBeenLastCalledWith("desktop.observe", {
        source: { kind: "environment", environmentId: desktopEnvironment.id },
        control: false,
      });
    }
  });

  it.each([
    { outcome: "ready", documentMode: false },
    { outcome: "ready", documentMode: true },
    { outcome: "retired", documentMode: false },
  ])(
    "keeps startup input disabled until $outcome (documentMode=$documentMode)",
    async ({ outcome, documentMode }) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const oldReady = createDeferred<EnvironmentSummary>();
      const replacement = { ...desktopEnvironment, id: "replacement-desktop" };
      let environment: EnvironmentSummary = {
        ...desktopEnvironment,
        status: "starting",
        desktop: false,
      };
      let reads = 0;
      const request = vi.fn(async (method: string, params?: { environmentId?: string }) => {
        if (method === "environments.status") {
          if (params?.environmentId === replacement.id) {
            return replacement;
          }
          reads += 1;
          return outcome === "retired" && reads > 1 ? oldReady.promise : environment;
        }
        return { transport: "rfb", wsPath: "/desktop/observe?token=synthetic", control: false };
      });
      const { panel, connect } = mount(request, { documentMode }, outcome === "ready");
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("environments.status", {
          environmentId: desktopEnvironment.id,
        }),
      );
      expect(reads).toBe(1);
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
      if (outcome === "retired") {
        expect(reads).toBe(2);
        panel.presented = false;
        await panel.updateComplete;
        oldReady.resolve(desktopEnvironment);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(reads).toBe(2);
        expect(connect).not.toHaveBeenCalled();
        panel.requestedSource = replacement.id;
        panel.presented = true;
        await panel.updateComplete;
      } else {
        environment = desktopEnvironment;
        await vi.advanceTimersByTimeAsync(2_000);
      }
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      expect(request).toHaveBeenLastCalledWith("desktop.observe", {
        source: {
          kind: "environment",
          environmentId: outcome === "retired" ? replacement.id : desktopEnvironment.id,
        },
        control: false,
      });
      if (outcome === "ready") {
        const calls = request.mock.calls.length;
        await vi.advanceTimersByTimeAsync(6_000);
        expect(request).toHaveBeenCalledTimes(calls);
      }
    },
  );

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
    const { panel, connect } = mount(request, {
      embedded: false,
      documentMode: true,
      sessionKey: null,
      requestedSource: null,
    });

    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".desktop-environment button")).not.toBeNull(),
    );
    clickPanelButton(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    expect(connect.mock.calls[0]?.[0].credentials).toEqual({
      password: "synthetic-worker-password",
    });
  });

  it.each([
    { presentation: "embedded", failure: "status" },
    { presentation: "session document", failure: "status" },
    { presentation: "source document", failure: "status" },
    { presentation: "session document", failure: "session" },
  ] as const)(
    "retries $failure lookup in the $presentation without global inventory",
    async ({ presentation, failure }) => {
      const sessionKey = "agent:main:cloud";
      const described = {
        session: {
          key: sessionKey,
          placement: { state: "active", environmentId: desktopEnvironment.id },
        },
      };
      const pending = createDeferred<EnvironmentSummary | typeof described>();
      let response = pending.promise;
      let failRefresh = false;
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.describe") {
          if (failRefresh) {
            throw new Error("Session lookup unavailable");
          }
          return failure === "session" ? response : described;
        }
        if (method === "environments.status") {
          return failure === "status" ? response : desktopEnvironment;
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
      const { panel, gateway, connect, disconnect } = mount(request, {
        embedded: presentation === "embedded",
        documentMode: presentation !== "embedded",
        sessionKey: presentation === "source document" ? null : sessionKey,
        requestedSource: presentation === "session document" ? null : desktopEnvironment.id,
      });
      if (failure === "status") {
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("environments.status", {
            environmentId: desktopEnvironment.id,
          }),
        );
        expect(
          request.mock.calls.filter(([method]) => method === "environments.status"),
        ).toHaveLength(1);
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.describe"),
        ).toHaveLength(presentation === "session document" ? 1 : 0);
        if (panel.embedded) {
          expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
        }
        expect(panel.renderRoot.querySelectorAll(".desktop-environment")).toHaveLength(0);
        expect(connect).not.toHaveBeenCalled();
      } else {
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("sessions.describe", { key: sessionKey }),
        );
      }
      const error =
        failure === "status" ? "Desktop is still starting" : "Session lookup unavailable";
      pending.reject(new Error(error));
      await waitForFast(() => expect(panel.renderRoot.textContent).toContain(error));
      expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
      expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
      response = Promise.resolve(failure === "session" ? described : desktopEnvironment);
      clickPanelButton(panel, ".desktop-status button");
      await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
      expect(request).toHaveBeenLastCalledWith("desktop.observe", {
        source: { kind: "environment", environmentId: desktopEnvironment.id },
        control: false,
      });
      expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
      expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
      if (failure === "session") {
        failRefresh = true;
        gateway.emit("sessions.changed", { sessionKey, reason: "placement" });
        await settleTasks();
        expect(disconnect).not.toHaveBeenCalled();
        expect(connect).toHaveBeenCalledOnce();
        expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
      }
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
      const { panel, gateway, connect } = mount(request, {
        embedded: false,
        documentMode: true,
        sessionKey,
        requestedSource: null,
      });
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
});
