/* @vitest-environment jsdom */

import type { DesktopObserveResult, EnvironmentSummary } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment,
  mountPanel,
  updatePanel,
} from "./desktop-panel.test-support.ts";

const observation = {
  transport: "rfb",
  wsPath: "/desktop/observe?token=synthetic",
  expiresAtMs: Date.now() + 60_000,
  control: false,
} satisfies DesktopObserveResult;
function rpcCalls<T extends unknown[]>(request: { mock: { calls: T[] } }, method: string) {
  return request.mock.calls.filter(([name]) => name === method);
}
function expectObserve(request: unknown, environmentId: string, control = false) {
  expect(request).toHaveBeenLastCalledWith("desktop.observe", {
    source: { kind: "environment", environmentId },
    control,
  });
}
function waitForStatus(request: unknown) {
  return waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("environments.status", {
      environmentId: desktopEnvironment.id,
    }),
  );
}
type Params = { control?: boolean; environmentId?: string };
type Reply = (params?: Params) => unknown;
function requests(handlers: Record<string, Reply>, fallback: Reply = () => observation) {
  return vi.fn(async (method: string, params?: Params) => (handlers[method] ?? fallback)(params));
}
const describeSession = (key: string, environmentId = desktopEnvironment.id) => ({
  session: { key, placement: { state: "active", environmentId } },
});

describe("session desktop connection", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount(
    request: ReturnType<typeof requests>,
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
    updatePanel(panel, {
      client: gateway.client,
      available: true,
      embedded: true,
      presented: true,
      sessionKey: "agent:main:preview",
      requestedSource: desktopEnvironment.id,
      desktopClientFactory: () => ({ connect }),
      ...options,
    });
    await mountPanel(panel);
    return { panel, gateway, connect, disconnect };
  }

  it("keeps a live source when a property burst restores the same connection inputs", async () => {
    const request = requests({ "environments.status": () => desktopEnvironment });
    const onFocusTargetChange = vi.fn();
    const { panel, gateway, connect, disconnect } = await mount(request, {
      sessionKey: null,
      onFocusTargetChange,
    });
    await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
    await panel.updateComplete;
    const current = connect.mock.calls[0]![0];
    const reads = request.mock.calls.length;
    const replacementRequest = vi.fn();
    const replacement = createGatewayClient(replacementRequest);

    panel.client = replacement.client;
    panel.available = false;
    panel.requestedSource = "transient-source";
    panel.client = gateway.client;
    panel.available = true;
    panel.requestedSource = desktopEnvironment.id;
    await panel.updateComplete;

    expect(current.isCurrent()).toBe(true);
    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(reads);
    expect(replacementRequest).not.toHaveBeenCalled();
    expect(onFocusTargetChange).toHaveBeenLastCalledWith({
      kind: "desktop",
      control: false,
      source: desktopEnvironment.id,
    });
  });

  it.each([
    { phase: "connected", explicit: false },
    { phase: "connected", explicit: true },
    { phase: "opening", explicit: true },
  ])("preserves the $phase source on show (explicit=$explicit)", async ({ phase, explicit }) => {
    const observed = createDeferred<DesktopObserveResult>();
    let first = true;
    const request = requests({
      "environments.status": (params) => ({
        ...desktopEnvironment,
        id: params?.environmentId ?? desktopEnvironment.id,
      }),
      "desktop.observe": (params) => {
        if (first) {
          first = false;
          if (phase === "opening") {
            return observed.promise;
          }
        }
        return { ...observation, control: params?.control ?? false };
      },
    });
    const onFocusTargetChange = vi.fn();
    const { panel, connect, disconnect } = await mount(request, { onFocusTargetChange });
    if (phase === "opening") {
      await waitForSolid(() => expect(first).toBe(false));
    } else {
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      clickPanelButton(panel, 'button[aria-label="Take control"]');
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
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
    await panel.updateComplete;
    expect(request).toHaveBeenCalledTimes(reads);
    if (phase === "opening") {
      observed.resolve(observation);
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      connect.mock.calls[0]![0].onDisconnect?.({ clean: true });
      await panel.updateComplete;
      show();
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(2));
      show("replacement");
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(3));
      expectObserve(request, "replacement");
    } else {
      expect(connect).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledTimes(disconnects);
      expect(connect.mock.calls[1]![0].isCurrent()).toBe(true);
      expect(onFocusTargetChange).toHaveBeenLastCalledWith({
        kind: "desktop",
        control: true,
        ...(explicit ? { source: desktopEnvironment.id } : { session: "agent:main:preview" }),
      });
      expect(panel.textContent).not.toContain("Agent input is paused");
      clickPanelButton(panel, 'button[aria-label="Switch to view only"]');
      await waitForSolid(() => expect(connect).toHaveBeenCalledTimes(3));
      expectObserve(request, desktopEnvironment.id);
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
      const request = requests({
        "environments.status": (params) => {
          if (params?.environmentId === replacement.id) {
            return replacement;
          }
          reads += 1;
          return outcome === "retired" && reads > 1 ? oldReady.promise : environment;
        },
      });
      const { panel, connect } = await mount(request, { documentMode }, outcome === "ready");
      await waitForStatus(request);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
      expect(panel.textContent).toContain("Starting your machine");
      const takeControl = [
        ...panel.querySelectorAll<HTMLButtonElement>('button[aria-label="Take control"]'),
      ];
      expect(takeControl.length).toBeGreaterThan(0);
      for (const button of takeControl) {
        expect(button.disabled).toBe(true);
        button.click();
      }
      expect(connect).not.toHaveBeenCalled();
      expect(rpcCalls(request, "desktop.observe")).toHaveLength(0);
      if (outcome === "retired") {
        expect(reads).toBe(2);
        updatePanel(panel, { presented: false });
        await panel.updateComplete;
        oldReady.resolve(desktopEnvironment);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(reads).toBe(2);
        expect(connect).not.toHaveBeenCalled();
        updatePanel(panel, { requestedSource: replacement.id, presented: true });
        await panel.updateComplete;
      } else {
        environment = desktopEnvironment;
        await vi.advanceTimersByTimeAsync(2_000);
      }
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      expectObserve(request, outcome === "retired" ? replacement.id : desktopEnvironment.id);
      if (outcome === "ready") {
        const calls = request.mock.calls.length;
        await vi.advanceTimersByTimeAsync(6_000);
        expect(request).toHaveBeenCalledTimes(calls);
      }
    },
  );

  it.each([
    { presentation: "embedded", failure: "status" },
    { presentation: "session document", failure: "status" },
    { presentation: "source document", failure: "status" },
    { presentation: "session document", failure: "session" },
  ] as const)(
    "retries $failure lookup in the $presentation without global inventory",
    async ({ presentation, failure }) => {
      const sessionKey = "agent:main:cloud";
      const described = describeSession(sessionKey);
      const pending = createDeferred<EnvironmentSummary | typeof described>();
      let response = pending.promise;
      let failRefresh = false;
      const request = requests(
        {
          "sessions.describe": () => {
            if (failRefresh) {
              throw new Error("Session lookup unavailable");
            }
            return failure === "session" ? response : described;
          },
          "environments.status": () => (failure === "status" ? response : desktopEnvironment),
          "desktop.observe": () => observation,
        },
        () => {
          throw new Error("Global inventory unavailable");
        },
      );
      const { panel, gateway, connect, disconnect } = await mount(request, {
        embedded: presentation === "embedded",
        documentMode: presentation !== "embedded",
        sessionKey: presentation === "source document" ? null : sessionKey,
        requestedSource: presentation === "session document" ? null : desktopEnvironment.id,
      });
      if (failure === "status") {
        await waitForStatus(request);
        expect(rpcCalls(request, "environments.status")).toHaveLength(1);
        expect(rpcCalls(request, "sessions.describe")).toHaveLength(
          presentation === "session document" ? 1 : 0,
        );
        if (panel.embedded) {
          expect(panel.querySelector(".desktop-picker")).toBeNull();
        }
        expect(panel.querySelectorAll(".desktop-environment")).toHaveLength(0);
        expect(connect).not.toHaveBeenCalled();
      } else {
        await waitForSolid(() =>
          expect(request).toHaveBeenCalledWith("sessions.describe", { key: sessionKey }),
        );
      }
      const error =
        failure === "status" ? "Desktop is still starting" : "Session lookup unavailable";
      pending.reject(new Error(error));
      await waitForSolid(() => expect(panel.textContent).toContain(error));
      expect(panel.querySelector(".desktop-picker")).toBeNull();
      expect(rpcCalls(request, "environments.list")).toHaveLength(0);
      response = Promise.resolve(failure === "session" ? described : desktopEnvironment);
      clickPanelButton(panel, ".desktop-status button");
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      expectObserve(request, desktopEnvironment.id);
      expect(rpcCalls(request, "environments.list")).toHaveLength(0);
      expect(panel.querySelector(".desktop-picker")).toBeNull();
      if (failure === "session") {
        failRefresh = true;
        gateway.emit("sessions.changed", { sessionKey, reason: "placement" });
        await panel.updateComplete;
        expect(disconnect).not.toHaveBeenCalled();
        expect(connect).toHaveBeenCalledOnce();
        expect(rpcCalls(request, "environments.list")).toHaveLength(0);
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
      let session: Promise<unknown> = Promise.resolve(describeSession(sessionKey));
      const request = requests(
        {
          "sessions.describe": () => session,
          "environments.status": (params) =>
            params?.environmentId === replacement.id ? replacement : previous.promise,
          "desktop.observe": () => observation,
        },
        () => {
          throw new Error("Global inventory must not participate");
        },
      );
      const { panel, gateway, connect } = await mount(request, {
        embedded: false,
        documentMode: true,
        sessionKey,
        requestedSource: null,
      });
      await waitForStatus(request);
      const previousRequest = request.mock.results.at(-1)!.value;
      session = nextSession.promise;
      gateway.emit("sessions.changed", { sessionKey, reason: "placement" });
      await waitForSolid(() => expect(rpcCalls(request, "sessions.describe")).toHaveLength(2));
      if (outcome === "failure") {
        previous.reject(new Error("Retired target unavailable"));
      } else {
        previous.resolve(desktopEnvironment);
      }
      await previousRequest.catch(() => undefined);
      await panel.updateComplete;
      expect(connect).not.toHaveBeenCalled();
      expect(panel.textContent).not.toContain("Retired target unavailable");
      if (outcome === "lookup failure") {
        nextSession.reject(new Error("Current target lookup unavailable"));
        await waitForSolid(() =>
          expect(panel.textContent).toContain("Current target lookup unavailable"),
        );
        expect(panel.querySelector(".desktop-status button")?.textContent).toContain("Retry");
        expect(connect).not.toHaveBeenCalled();
        expect(rpcCalls(request, "environments.list")).toHaveLength(0);
        return;
      }
      nextSession.resolve(describeSession(sessionKey, replacement.id));
      await waitForSolid(() => expect(connect).toHaveBeenCalledOnce());
      expectObserve(request, replacement.id);
      expect(rpcCalls(request, "sessions.describe")).toHaveLength(2);
      expect(rpcCalls(request, "environments.list")).toHaveLength(0);
    },
  );
});
