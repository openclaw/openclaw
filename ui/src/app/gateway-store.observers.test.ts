// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadCommandPaletteCatalogItems } from "../components/command-palette-catalog-search.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatar } from "../lib/identity-avatar.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore as createStore,
  GATEWAY_STORE_TEST_HELLO as HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { loadSettings } from "./settings.ts";
import type { scheduleStaleChunkReload } from "./stale-chunk-reload.ts";

const { scheduleStaleChunkReloadMock } = vi.hoisted(() => ({
  scheduleStaleChunkReloadMock: vi.fn<typeof scheduleStaleChunkReload>(async () => true),
}));

vi.mock("./stale-chunk-reload.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stale-chunk-reload.ts")>()),
  scheduleStaleChunkReload: scheduleStaleChunkReloadMock,
}));

vi.mock("../build-info.ts", () => ({
  CONTROL_UI_BUILD_INFO: { version: "2026.7.19", buildId: "test" },
  controlUiBuildDiffersFrom: (identity: {
    version?: string | null;
    buildId?: string | null;
    controlUiBuildSource?: "bundled" | "configured";
  }) =>
    identity.controlUiBuildSource === "configured"
      ? false
      : identity.buildId
        ? identity.buildId !== "test"
        : Boolean(identity.version && identity.version !== "2026.7.19"),
}));

describe("createApplicationGateway connection ownership", () => {
  let gateway: ReturnType<typeof createStore>["gateway"];
  let current: ReturnType<typeof createStore>["current"];
  let clients: ReturnType<typeof createStore>["clients"];
  beforeEach(() => {
    scheduleStaleChunkReloadMock.mockClear();
    stubGatewayStoreTestGlobals();
    ({ gateway, current, clients } = createStore());
  });

  afterEach(async () => {
    gateway.stop();
    await vi.dynamicImportSettled();
    setAvatarGatewayOrigin(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function connect() {
    gateway.start();
    current().opts.onHello?.(HELLO);
  }

  function unavailable(reason: string, details: Record<string, unknown>, code = 1013) {
    return {
      code,
      reason,
      willRetry: true,
      error: { code: "UNAVAILABLE", message: reason, retryable: true, details },
    };
  }

  function rejectUnavailable(reason: string, phase?: string) {
    current().opts.onClose?.(unavailable(reason, { reason, phase }));
  }

  it("passes the explicit same-origin resource base to avatar resolution", () => {
    const settings = { ...loadSettings(), gatewayUrl: "ws://127.0.0.1:18789/ws" };
    ({ gateway } = createStore({ settings, resourceBasePath: "/wilfred" }));

    gateway.start();

    expect(
      resolveAvatar({ id: "a@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).toEqual({
      kind: "profile",
      url: "http://127.0.0.1:18789/wilfred/api/users/p1/avatar",
    });
  });

  it("does not reload a native stale hello after its observer replaces the connection", async () => {
    const actual =
      await vi.importActual<typeof import("./stale-chunk-reload.ts")>("./stale-chunk-reload.ts");
    scheduleStaleChunkReloadMock.mockImplementationOnce(actual.scheduleStaleChunkReload);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const replace = vi.fn();
    const location = Object.assign(new URL("http://127.0.0.1:18789/chat/main"), { replace });
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location }));
    vi.stubGlobal(
      "document",
      Object.assign(new EventTarget(), {
        documentElement: { getAttribute: () => null },
        querySelector: () => null,
      }),
    );
    ({ gateway, current } = createStore({
      clientOptions: { clientName: "openclaw-ios", mode: "ui" },
    }));
    gateway.connect({ bootstrapToken: "synthetic-native-bootstrap", bootstrapProfile: "owner" });
    gateway.subscribe((snapshot) => {
      if (snapshot.phase === "reconnecting") {
        expect(snapshot.canvasPluginSurfaceUrl).toBeNull();
        expect(current().request).not.toHaveBeenCalled();
        gateway.connect();
      }
    });
    current().opts.onHello?.({
      ...HELLO,
      server: { version: "2026.7.19", buildId: "replacement-build", connId: "native-conn" },
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/hello" },
    });
    await scheduleStaleChunkReloadMock.mock.results[0]?.value;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(current().opts.bootstrapToken).toBeUndefined();
    expect(current().opts.bootstrapProfile).toBeUndefined();
    expect(sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId")).toBeNull();
  });

  it("keeps legacy version fallback on reconnect instead of first admission", () => {
    gateway.start();
    const legacyHello = {
      ...HELLO,
      server: { version: "2026.7.20", connId: "legacy-conn" },
    };

    current().opts.onHello?.(legacyHello);
    expect(gateway.snapshot.phase).toBe("connected");

    current().opts.onClose?.({ code: 1006, reason: "restarting", willRetry: true });
    current().opts.onHello?.(legacyHello);
    expect(gateway.snapshot.phase).toBe("reconnecting");
  });

  it("does not invent an assistant agent id before the gateway advertises one", () => {
    expect(gateway.snapshot.assistantAgentId).toBeNull();
    connect();
    expect(gateway.snapshot.assistantAgentId).toBeNull();

    gateway.connect();
    current().opts.onHello?.({
      ...HELLO,
      snapshot: { sessionDefaults: { defaultAgentId: "roboclaw" } },
    });
    expect(gateway.snapshot.assistantAgentId).toBe("roboclaw");
    gateway.stop();
    expect(gateway.snapshot.assistantAgentId).toBeNull();
  });

  it("does not let a superseded canvas refresh publish into the current snapshot", async () => {
    const firstRefresh = createDeferred<unknown>();
    gateway.start();
    const first = current();
    first.request.mockImplementation((method) =>
      method === "plugin.surface.refresh"
        ? firstRefresh.promise
        : Promise.resolve({ profile: { id: "reader", emails: [] } }),
    );
    first.opts.onHello?.({
      ...HELLO,
      auth: { role: "operator", scopes: ["operator.read"] },
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/first" },
    });
    await vi.dynamicImportSettled();
    expect(first.request).toHaveBeenCalledWith("plugin.surface.refresh", {
      surface: "canvas",
      observedUrl: "https://canvas.test/__openclaw__/cap/first",
    });

    gateway.connect();
    current().opts.onHello?.({
      ...HELLO,
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/current" },
    });
    firstRefresh.resolve({
      surface: "canvas",
      pluginSurfaceUrls: { canvas: "https://canvas.test/__openclaw__/cap/stale-refresh" },
      expiresAtMs: Date.now() + 60_000,
    });
    await vi.dynamicImportSettled();

    expect(gateway.snapshot.canvasPluginSurfaceUrl).toBe(
      "https://canvas.test/__openclaw__/cap/current",
    );
  });

  it("keeps retryable startup unavailable in the initial progress state", () => {
    gateway.start();

    const startupClose = unavailable(
      "gateway starting; retry shortly",
      { reason: "startup-sidecars" },
      4013,
    );
    Object.assign(startupClose.error, { retryAfterMs: 250 });
    current().opts.onClose?.(startupClose);

    expect(gateway.snapshot.phase).toBe("starting");
    expect(gateway.snapshot.lastError).toBeNull();
    expect(gateway.snapshot.lastErrorCode).toBeNull();

    const listener = vi.fn();
    gateway.subscribe(listener);
    current().opts.onClose?.(startupClose);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "OPENAI_API_KEY=sk-1234567890abcdef", willRetry: true },
    { reason: "", willRetry: true },
    { reason: "", willRetry: false },
  ])("explains a close safely ($reason, retry=$willRetry)", ({ reason, willRetry }) => {
    if (reason) {
      gateway.start();
    } else {
      connect();
    }
    current().opts.onClose?.({ code: 1006, reason, willRetry });
    if (reason) {
      expect(gateway.snapshot.lastError).toContain("OPENAI_API_KEY=sk-123...cdef");
      expect(gateway.snapshot.lastError).not.toContain("sk-1234567890abcdef");
    } else {
      expect(gateway.snapshot.phase).toBe(willRetry ? "reconnecting" : "offline");
      expect(gateway.snapshot.lastError).toBe(
        willRetry
          ? "Connection to the Gateway was interrupted. Reconnecting automatically. (WebSocket 1006)"
          : "Connection to the Gateway was interrupted. Check your connection and try again. (WebSocket 1006)",
      );
    }
  });

  it("switches Gateway selection, credentials, and first-retry ownership together", () => {
    const otherGateway = "wss://other-gateway.example.test";
    const selection = {
      sessionKey: "global",
      lastActiveSessionKey: "global",
      selectedAgentId: "research",
    };
    localStorage.setItem(
      `openclaw.control.settings.v1:${otherGateway}`,
      JSON.stringify({
        gatewayUrl: otherGateway,
        sessionsByGateway: { [otherGateway]: selection },
      }),
    );
    ({ gateway, current } = createStore({
      settings: { ...loadSettings(), selectedAgentId: "openclaw", token: "old-token" },
    }));
    connect();
    gateway.connect({ password: "old-password", bootstrapToken: "old-bootstrap" });
    gateway.connect({ gatewayUrl: otherGateway });

    expect(gateway.snapshot.sessionKey).toBe("global");
    expect(loadSettings()).toMatchObject(selection);
    expect(current().opts.token).toBeUndefined();
    expect(current().opts.password).toBeUndefined();
    expect(current().opts.bootstrapToken).toBeUndefined();
    current().opts.onClose?.({ code: 1006, reason: "remote refused", willRetry: true });
    expect(gateway.snapshot.phase).toBe("connecting");
    expect(gateway.snapshot.lastError).toBe("disconnected (1006): remote refused");
  });

  it("advances the connection revision only when credentials change", () => {
    connect();
    expect(gateway.connectionRevision).toBe(0);
    gateway.connect({ sessionKey: "agent:main:other" });
    expect(gateway.connectionRevision).toBe(0);

    gateway.connect({ token: "replacement-token" });
    expect(gateway.connectionRevision).toBe(1);
  });

  it("keeps reload-required ahead of retryable startup presentation", () => {
    gateway.start();

    current().opts.onClose?.(
      unavailable(
        "Control UI updated; reload this page to continue",
        {
          code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
          reason: "startup-sidecars",
          gatewayBuildId: "replacement-build",
          reloadRequired: true,
        },
        1008,
      ),
    );

    expect(scheduleStaleChunkReloadMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ buildId: "replacement-build" }),
    );
    expect(gateway.snapshot.phase).toBe("reload-required");
    expect(gateway.snapshot.lastError).toContain("Control UI updated");
    expect(gateway.snapshot.lastErrorCode).toBe(ConnectErrorDetailCodes.PROTOCOL_MISMATCH);
  });

  it.each([false, true])(
    "discards a gapped frame when recovery replaces its client (observer=%s)",
    (observer) => {
      const listener = vi.fn();
      gateway.subscribeEventLog(() => {});
      gateway.subscribeEvents(listener);
      connect();
      const stale = current();
      if (observer) {
        gateway.subscribe((snapshot) => {
          if (snapshot.lastError?.startsWith("event gap detected")) {
            gateway.connect();
          }
        });
      }
      // The protocol invokes onGap before onEvent for the same received frame.
      stale.opts.onGap?.({ expected: 2, received: 5 });
      stale.opts.onEvent?.(createGatewayEvent("stale.gap", { stale: true }, 5));
      expect(listener).not.toHaveBeenCalled();
      expect(gateway.eventLog).toEqual([]);
      expect(clients).toHaveLength(2);
      expect(current().started).toBe(1);
      expect(gateway.snapshot.client).toBe(current());
      const activeEvent = createGatewayEvent("fresh.event", { active: true }, 6);
      current().opts.onEvent?.(activeEvent);
      expect(listener).toHaveBeenCalledExactlyOnceWith(activeEvent);
      expect(gateway.eventLog).toMatchObject([{ event: "fresh.event", payload: { active: true } }]);
    },
  );

  it.each(["subscription change", "exception"])(
    "isolates event subscribers from an earlier %s",
    (action) => {
      const second = vi.fn();
      const third = vi.fn();
      let unsubscribeSecond = () => {};
      vi.spyOn(console, "error").mockImplementation(() => {});
      const first = vi.fn(() => {
        if (action === "exception") {
          throw new Error("subscriber failed");
        }
        unsubscribeSecond();
        gateway.subscribeEvents(third);
      });
      gateway.subscribeEventLog(() => {});
      gateway.subscribeEvents(first);
      unsubscribeSecond = gateway.subscribeEvents(second);
      gateway.start();
      const firstEvent = createGatewayEvent("chat", { text: "first" });
      current().opts.onEvent?.(firstEvent);
      expect(first).toHaveBeenCalledExactlyOnceWith(firstEvent);
      expect(second).toHaveBeenCalledExactlyOnceWith(firstEvent);
      expect(third).not.toHaveBeenCalled();
      expect(gateway.eventLog).toMatchObject([{ event: "chat", payload: { text: "first" } }]);
      if (action === "subscription change") {
        const secondEvent = createGatewayEvent("chat", { text: "second" }, 2);
        current().opts.onEvent?.(secondEvent);
        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledOnce();
        expect(third).toHaveBeenCalledExactlyOnceWith(secondEvent);
      }
    },
  );

  it("keeps ephemeral login on the serving gateway from persisting the selection", () => {
    const pageGateway = "ws://127.0.0.1:18789";
    const remoteGateway = "wss://saved-remote.example.test";
    const otherGateway = "wss://other-remote.example.test";
    const pageSettingsKey = `openclaw.control.settings.v1:${pageGateway}`;
    const selectionKey = `openclaw.control.currentGateway.v1:${pageGateway}`;
    const settings = loadSettings();
    localStorage.setItem(selectionKey, remoteGateway);
    ({ gateway, current } = createStore({
      settings,
      persistDefaultConnectionSettings: false,
    }));

    gateway.start();
    gateway.connect({ gatewayUrl: pageGateway, token: "approval-token", password: "pw" });

    expect(current().opts.url).toBe(pageGateway);
    expect(current().opts.token).toBe("approval-token");
    expect(localStorage.getItem(pageSettingsKey)).toBeNull();
    expect(localStorage.getItem(selectionKey)).toBe(remoteGateway);

    gateway.connect({ gatewayUrl: otherGateway });

    expect(current().opts.url).toBe(otherGateway);
    expect(localStorage.getItem(selectionKey)).toBe(otherGateway);
  });

  it("retains each usage publication once until its connection retires", () => {
    connect();
    const observed = vi.fn();
    const stop = gateway.subscribe(observed);
    observed.mockClear();
    const publish = (usageUpdatedAt: number, usageRefreshFailed = false, agentId = "main") =>
      current().opts.onEvent?.(
        createGatewayEvent("chat.metadata.changed", {
          agentId,
          usageUpdatedAt,
          usageRefreshFailed,
          modelCatalogChanged: false,
          authChanged: false,
        }),
      );
    for (const usageUpdatedAt of [20, 20, 10]) {
      publish(usageUpdatedAt);
    }
    expect(gateway.snapshot.usagePublications?.main?.usageUpdatedAt).toBe(20);
    expect(observed).toHaveBeenCalledOnce();
    publish(21, true);
    expect(gateway.snapshot.usagePublications?.main).toMatchObject({
      usageRefreshFailed: true,
      committedAt: 20,
    });
    const failed = gateway.snapshot.usagePublications?.main;
    publish(22, false, "other");
    expect(gateway.snapshot.usagePublications?.main).toBe(failed);
    publish(23);
    expect(gateway.snapshot.usagePublications?.main?.usageRefreshFailed).toBeUndefined();
    expect(failed).toMatchObject({ usageUpdatedAt: 21, usageRefreshFailed: true });
    current().opts.onClose?.({ code: 1001, reason: "restart", willRetry: true });
    expect(gateway.snapshot.usagePublications).toBeUndefined();
    current().opts.onHello?.(HELLO);
    publish(1);
    expect(gateway.snapshot.usagePublications?.main?.usageUpdatedAt).toBe(1);
    stop();
  });

  it("invalidates palette automation reads before delivering owner events and reconnects", async () => {
    connect();
    const client = gateway.snapshot.client!;
    current().request.mockImplementation(async (method) =>
      method === "cron.list" ? { jobs: [{ id: "job", name: "Automation" }] } : { models: [] },
    );
    const load = () =>
      loadCommandPaletteCatalogItems({
        client,
        agentId: "main",
        agents: async () => null,
        methodAvailable: (method) => method === "cron.list",
      });
    const count = () =>
      current().request.mock.calls.filter(([method]) => method === "cron.list").length;
    const [first, shared] = await Promise.all([load(), load()]);
    expect(first).toEqual(shared);
    expect(first).toContainEqual(expect.objectContaining({ label: "Automation" }));
    expect(count()).toBe(1);
    for (const event of ["cron", "config.changed"]) {
      let pending: ReturnType<typeof load> | undefined;
      const unsubscribe = gateway.subscribeEvents(() => {
        pending = load();
      });
      current().opts.onEvent?.({ type: "event", event, payload: {} });
      await pending;
      unsubscribe();
    }
    expect(count()).toBe(3);
    current().opts.onHello?.({ ...HELLO });
    await load();
    expect(count()).toBe(4);
  });

  it.each(["event log", "snapshot"])(
    "retires event delivery when a %s observer replaces its client",
    (stage) => {
      const logged = vi.fn();
      const delivered = vi.fn();
      if (stage === "event log") {
        gateway.subscribeEventLog(() => gateway.connect());
      } else {
        gateway.subscribe((snapshot) => {
          if (snapshot.usagePublications?.main?.usageUpdatedAt === 1) {
            gateway.connect();
          }
        });
      }
      gateway.subscribeEventLog(logged);
      gateway.subscribeEvents(delivered);
      connect();
      current().opts.onEvent?.(
        stage === "event log"
          ? createGatewayEvent("chat", { text: "event-1" }, 1)
          : createGatewayEvent("chat.metadata.changed", { agentId: "main", usageUpdatedAt: 1 }),
      );
      expect(logged).not.toHaveBeenCalled();
      expect(delivered).not.toHaveBeenCalled();
      expect(gateway.snapshot.selfUser).toBeNull();
      expect(clients).toHaveLength(2);
      expect(gateway.snapshot.phase).toBe("reconnecting");
      if (stage === "event log") {
        expect(gateway.eventLog).toHaveLength(1);
      } else {
        expect(gateway.eventLog).toEqual([]);
      }
    },
  );

  it("defaults unknown suspension evidence while reconnecting and replaces it on hello", async () => {
    vi.useFakeTimers();
    connect();
    rejectUnavailable("gateway-suspending", "unknown");
    expect(gateway.snapshot.phase).toBe("reconnecting");
    expect(gateway.snapshot.suspensionPhase).toBe("prepared");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(gateway.snapshot.offlineStable).toBe(true);
    expect(gateway.snapshot.suspensionPhase).toBe("prepared");
    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.suspensionPhase).toBeUndefined();
    current().opts.onEvent?.(createGatewayEvent("gateway.suspension", { phase: "prepared" }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(gateway.snapshot.suspensionPhase).toBe("prepared");
  });

  it.each(["suspension", "restart"])(
    "expires %s evidence at its deadline into stable offline",
    async (kind) => {
      vi.useFakeTimers();
      if (kind === "suspension") {
        gateway.start();
        rejectUnavailable("gateway-suspending", "prepared");
        expect(gateway.snapshot.phase).toBe("connecting");
        expect(gateway.snapshot.suspensionPhase).toBe("prepared");
        await vi.advanceTimersByTimeAsync(10_000);
        rejectUnavailable("gateway-suspending", "prepared");
      } else {
        connect();
        current().opts.onEvent?.(
          createGatewayEvent("shutdown", {
            reason: "gateway restart",
            restartExpectedMs: 8_000,
          }),
        );
        current().opts.onClose?.({ code: 1012, reason: "gateway restarting", willRetry: true });
      }
      await vi.advanceTimersByTimeAsync(kind === "suspension" ? 14_999 : 23_999);
      if (kind === "suspension") {
        expect(gateway.snapshot.suspensionPhase).toBe("prepared");
      } else {
        expect(gateway.snapshot.restartPending).toBe(true);
      }
      expect(gateway.snapshot.offlineStable).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      if (kind === "suspension") {
        expect(gateway.snapshot.suspensionPhase).toBeUndefined();
      } else {
        expect(gateway.snapshot.restartPending).toBe(false);
      }
      expect(gateway.snapshot.offlineStable).toBe(true);
    },
  );

  it("recognizes the structured restart rejection before the first successful hello", () => {
    gateway.start();
    rejectUnavailable("gateway-restarting");
    expect(gateway.snapshot.phase).toBe("connecting");
    expect(gateway.snapshot.restartPending).toBe(true);
  });
});
