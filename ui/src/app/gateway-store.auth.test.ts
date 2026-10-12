// @vitest-environment node
import { setImmediate as nextTurn } from "node:timers/promises";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { EventLogEntry } from "../api/event-log.ts";
import { GatewayRequestError, type GatewayHelloOk } from "../api/gateway.ts";
import { goalOperationScopePrefix } from "../lib/chat/goal-operation-storage.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { clearStoredChatSnapshots } from "../pages/chat/session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import type { BootRecord } from "./boot-record.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore as createStore,
  GATEWAY_STORE_TEST_HELLO as HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import type { ApplicationGatewayConnectOptions } from "./gateway.ts";
import { loadSettings, persistSessionToken, saveSettings } from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";

const RELOAD_GUARD_KEY = "openclaw.controlUi.staleChunkReloadBuildId";

function stubBuildReloadDocument(href = "http://127.0.0.1:18789/chat/main") {
  const replace = vi.fn<(url: string) => void>();
  const location = Object.assign(new URL(href), { replace });
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location }));
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      documentElement: { getAttribute: () => null },
      querySelector: () => null,
    }),
  );
  const probe = createDeferred<Response>();
  const fetchMock = vi.fn<typeof fetch>(() => probe.promise);
  vi.stubGlobal("fetch", fetchMock);
  return { replace, probe, fetchMock };
}

function hello(recoveryScope: string): GatewayHelloOk {
  return {
    ...HELLO,
    auth: { role: "operator", scopes: [], recoveryScope },
  };
}

const A_EVENT = createGatewayEvent("chat", { text: "Gateway A message" });
const B_EVENT = createGatewayEvent("chat", { text: "Gateway B message" });
const B_URL = "wss://gateway-b.example.test";
const C_URL = "wss://gateway-c.example.test";

describe("createApplicationGateway authentication diagnostics", () => {
  let store: ReturnType<typeof createStore>;
  let gateway: ReturnType<typeof createStore>["gateway"];
  let current: ReturnType<typeof createStore>["current"];

  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    stubGatewayStoreTestGlobals();
    store = createStore();
    ({ gateway, current } = store);
  });

  afterEach(async () => {
    gateway.stop();
    await vi.dynamicImportSettled();
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects a different development target before accepting its credentials or opening a client", () => {
    const configured = gateway.connection.gatewayUrl;
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", { gatewayUrl: configured, proxyPath: "/dev-proxy" });
    gateway.connect({ token: "configured-credential" });
    current().opts.onHello?.({ ...HELLO, snapshot: { authMode: "token" } });
    const connection = { ...gateway.connection };

    gateway.connect({ gatewayUrl: "wss://other.example", token: "other-credential" });
    expect(store.clients).toHaveLength(1);
    expect(current().stopped).toBe(1);
    expect(gateway.connection).toEqual(connection);
    expect(loadSettings().token).toBe("configured-credential");
    expect(gateway.snapshot.phase).toBe("offline");
    expect(gateway.snapshot.lastError).toContain("OPENCLAW_UI_DEV_GATEWAY_URL");

    gateway.connect();
    expect(store.clients).toHaveLength(2);
    expect(current().opts).toMatchObject({ url: configured, token: "configured-credential" });
  });

  it("does not persist a password-mode secret or accept a retired client hello", () => {
    const gatewayUrl = gateway.connection.gatewayUrl;
    const secret = "synthetic-gateway-secret";
    persistSessionToken(gatewayUrl, "previous-token");
    const write = vi.spyOn(sessionStorage, "setItem");
    gateway.connect({ token: secret });
    const retired = current();
    saveSettings({ ...loadSettings(), token: secret });
    expect(write).not.toHaveBeenCalled();
    expect(loadSettings().token).toBe("previous-token");

    current().opts.onHello?.({ ...HELLO, snapshot: { authMode: "password" } });
    expect(loadSettings().token).toBe("");
    expect(gateway.connection.token).toBe(secret);
    expect(write).not.toHaveBeenCalled();

    // Late hello from a replaced client must not persist its submitted secret.
    gateway.connect({ token: "replacement-secret" });
    retired.opts.onHello?.({ ...HELLO, snapshot: { authMode: "token" } });
    expect(loadSettings().token).toBe("");
  });

  function rejection(
    details: Record<string, unknown>,
    code = "INVALID_REQUEST",
    message = "unauthorized",
    socketCode = 1008,
  ) {
    return {
      code: socketCode,
      reason: message,
      willRetry: false,
      error: { code, message, details },
    };
  }

  function rejectStaleBuild() {
    current().opts.onClose?.(
      rejection(
        {
          code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
          gatewayBuildId: "replacement-build",
          reloadRequired: true,
        },
        "UNAVAILABLE",
        "Control UI updated",
      ),
    );
  }

  it.each([
    { action: "resume", jitter: 0, elapsed: 1_000, probes: 2, reloads: 1 },
    { action: "stop during initial jitter", jitter: 0.5, elapsed: 30_000, probes: 0, reloads: 0 },
    { action: "stop during probe retry", jitter: 0, elapsed: 30_000, probes: 1, reloads: 0 },
  ])("keeps build recovery owned by the current connection: $action", async (scenario) => {
    vi.useFakeTimers();
    vi.mocked(Math.random).mockReturnValue(scenario.jitter);
    const { replace, fetchMock } = stubBuildReloadDocument();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    gateway.start();
    rejectStaleBuild();
    await vi.advanceTimersByTimeAsync(0);
    if (scenario.action === "resume") {
      gateway.connect();
      rejectStaleBuild();
    } else {
      gateway.stop();
    }

    await vi.advanceTimersByTimeAsync(scenario.elapsed);
    expect(replace).toHaveBeenCalledTimes(scenario.reloads);
    expect(fetchMock).toHaveBeenCalledTimes(scenario.probes);
    expect(sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe(
      scenario.reloads ? "replacement-build" : null,
    );
  });

  it.each(["replacement", "retired"] as const)(
    "keeps the pending document probe bound to the %s handoff",
    async (handoff) => {
      const bootstrapToken = "synthetic-owner-bootstrap";
      const initialUrl = new URL(
        `http://127.0.0.1:18789/settings/appearance?keep=yes#tab=keep&bootstrapToken=${bootstrapToken}&bootstrapProfile=owner`,
      );
      const startup = resolveApplicationStartupSettings(loadSettings(), initialUrl);
      expect(startup.location.hash).toBe("#tab=keep");
      const { pathname, search, hash } = startup.location;
      const { replace, probe, fetchMock } = stubBuildReloadDocument(
        new URL(`${pathname}${search}${hash}`, initialUrl).href,
      );
      gateway.connect({
        bootstrapToken: startup.pendingBootstrapToken ?? "",
        bootstrapProfile: startup.pendingBootstrapProfile ?? undefined,
      });
      rejectStaleBuild();
      expect(gateway.snapshot.phase).toBe("reload-required");
      expect(fetchMock).toHaveBeenCalledOnce();

      gateway.connect({
        bootstrapToken: "replacement-bootstrap",
        bootstrapProfile: handoff === "replacement" ? "owner" : undefined,
      });
      if (handoff === "replacement") {
        rejectStaleBuild();
      }
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("HEAD");
      probe.resolve(new Response(null, { status: 200 }));
      if (handoff === "retired") {
        await nextTurn();
        expect(replace).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull();
        return;
      }
      await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
      const destination = new URL(replace.mock.calls[0]![0]);
      const resumed = resolveApplicationStartupSettings(loadSettings(), destination);
      expect(resumed.pendingBootstrapToken).toBe(
        handoff === "replacement" ? "replacement-bootstrap" : bootstrapToken,
      );
      expect(resumed.pendingBootstrapProfile).toBe("owner");
      expect(resumed.location.pathname).toBe("/settings/appearance");
      expect(new URLSearchParams(resumed.location.search).get("keep")).toBe("yes");
      expect(resumed.location.hash).toBe("#tab=keep");
      expect(resumed.settings.token).toBe("");
      for (const storage of [localStorage, sessionStorage]) {
        for (let index = 0; index < storage.length; index++) {
          expect(storage.getItem(storage.key(index)!)).not.toContain(bootstrapToken);
          expect(storage.getItem(storage.key(index)!)).not.toContain("replacement-bootstrap");
        }
      }
    },
  );

  it("retires a rejected browser handoff before retrying with the Gateway secret", () => {
    gateway.connect({ bootstrapToken: "synthetic-used-bootstrap", bootstrapProfile: "owner" });
    current().opts.onClose?.(
      rejection(
        { code: ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID },
        "INVALID_REQUEST",
        "unauthorized: bootstrap token invalid",
        4008,
      ),
    );
    gateway.connect({ token: "synthetic-replacement-secret" });

    expect(current().opts.token).toBe("synthetic-replacement-secret");
    expect(current().opts.bootstrapToken).toBeUndefined();
    expect(current().opts.bootstrapProfile).toBeUndefined();
  });

  it("does not reload the serving document for a remote Gateway", async () => {
    const { replace, fetchMock } = stubBuildReloadDocument();
    gateway.connect({
      gatewayUrl: "wss://other-gateway.example",
      bootstrapToken: "synthetic-remote-bootstrap",
      bootstrapProfile: "owner",
    });
    rejectStaleBuild();
    await nextTurn();
    expect(replace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gateway.snapshot.phase).toBe("reload-required");
  });

  it.each([
    { authReason: "trusted_proxy_user_not_allowed", expected: "trusted_proxy_user_not_allowed" },
  ])("projects only a current recognized auth reason: $authReason", ({ authReason, expected }) => {
    gateway.start();
    const rejected = rejection({
      code: ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
      authReason,
    });
    current().opts.onClose?.(rejected);
    expect(gateway.snapshot.lastErrorAuthReason).toBe(expected);

    const stale = current();
    gateway.connect();
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
    stale.opts.onClose?.(rejected);
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();

    current().opts.onClose?.(rejected);
    current().opts.onHello?.(HELLO);
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
    current().opts.onClose?.(rejected);
    current().opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
    current().opts.onClose?.(rejected);
    gateway.stop();
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
  });

  describe("diagnostic history ownership", () => {
    let stopDiagnostics: () => void;
    beforeEach(() => {
      stopDiagnostics = gateway.subscribeEventLog(() => {});
      gateway.start();
      current().opts.onHello?.(hello("account-a"));
      current().opts.onEvent?.(A_EVENT);
    });
    it("captures bounded immutable history only while diagnostics is subscribed", () => {
      stopDiagnostics();
      const idleHistory = gateway.eventLog;
      const delivered = vi.fn();
      gateway.subscribeEvents(delivered);
      current().opts.onEvent?.(A_EVENT);
      expect(gateway.eventLog).toBe(idleHistory);
      expect(gateway.eventLog).toEqual([]);
      expect(delivered).toHaveBeenCalledExactlyOnceWith(A_EVENT);

      const observed = vi.fn();
      const stopFirst = gateway.subscribeEventLog(observed);
      const stopSecond = gateway.subscribeEventLog(() => {});
      current().opts.onEvent?.(A_EVENT);
      const captured = gateway.eventLog;
      stopFirst();
      for (let index = 0; index < 251; index++) {
        current().opts.onEvent?.(createGatewayEvent("chat", { index }));
      }
      expect(observed).toHaveBeenCalledOnce();
      expect(captured.map((entry) => entry.payload)).toEqual([A_EVENT.payload]);
      expect(gateway.eventLog).toHaveLength(250);
      expect(gateway.eventLog[0]?.payload).toEqual({ index: 250 });
      expect(gateway.eventLog.at(-1)?.payload).toEqual({ index: 1 });

      stopSecond();
      expect(gateway.eventLog).toEqual([]);
      expect(gateway.eventLogRevision).toBe(0);
      const stopReopened = gateway.subscribeEventLog(observed);
      expect(gateway.eventLog).toEqual([]);
      current().opts.onEvent?.(B_EVENT);
      expect(gateway.eventLog.map((entry) => entry.payload)).toEqual([B_EVENT.payload]);
      stopReopened();
    });

    it.each([["shared token", { token: "synthetic-replacement-token" }]] satisfies Array<
      [string, ApplicationGatewayConnectOptions]
    >)("retires old payloads before connecting with a changed %s", (_name, overrides) => {
      const oldClient = current();
      const observed = vi.fn<(events: readonly EventLogEntry[]) => void>();
      gateway.subscribeEventLog(observed);

      gateway.connect(overrides);

      expect(gateway.eventLog).toEqual([]);
      expect(observed).toHaveBeenLastCalledWith([]);
      expect(gateway.eventLogRevision).toBe(1);
      oldClient.opts.onEvent?.(A_EVENT);
      expect(gateway.eventLog).toEqual([]);
    });

    it.each(["account-a", ""])(
      "retires unowned goal payloads for resolved scope %j",
      (recoveryScope) => {
        const ownKey = `${goalOperationScopePrefix(gateway.connection.gatewayUrl, recoveryScope)}session`;
        const oldKey = `${goalOperationScopePrefix(gateway.connection.gatewayUrl, "account-b")}session`;
        const otherGatewayKey = `${goalOperationScopePrefix(B_URL, "account-b")}session`;
        const request = JSON.stringify({ objective: "Private goal edit", issuedAtMs: Date.now() });
        for (const key of [ownKey, oldKey, otherGatewayKey]) {
          sessionStorage.setItem(key, request);
        }
        if (recoveryScope === "") {
          current().opts.onHello?.(HELLO);
        }
        Object.defineProperty(current(), "recoveryScope", { value: recoveryScope });
        current().opts.onRecoveryScopeChange?.();
        expect(sessionStorage.getItem(ownKey)).toBe(recoveryScope ? request : null);
        expect(sessionStorage.getItem(oldKey)).toBeNull();
        expect(sessionStorage.getItem(otherGatewayKey)).toBe(request);
      },
    );

    it("preserves same-account history through session selection", () => {
      const history = gateway.eventLog;
      gateway.setSessionKey("agent:main:another");
      expect(gateway.eventLog).toBe(history);
      expect(gateway.eventLogRevision).toBe(0);
    });

    it("retires an account change at unchanged settings without requiring presence", () => {
      const observed = vi.fn<(events: readonly EventLogEntry[]) => void>();
      gateway.subscribeEventLog(observed);
      current().opts.onClose?.({ code: 1006, reason: "lost", willRetry: true });

      current().opts.onHello?.(hello("account-b"));

      expect(gateway.snapshot.selfUser).toBeNull();
      expect(gateway.connectionRevision).toBe(0);
      expect(gateway.eventLog).toEqual([]);
      expect(gateway.eventLogRevision).toBe(1);
      expect(observed).toHaveBeenLastCalledWith([]);

      current().opts.onEvent?.(B_EVENT);
      current().opts.onHello?.(hello("account-b"));
      current().opts.onRecoveryScopeChange?.();
      expect(gateway.eventLog.map((event) => event.payload)).toEqual([B_EVENT.payload]);
      expect(gateway.eventLogRevision).toBe(1);
    });

    it.each(["replace", "record"] as const)(
      "keeps retirement current when a log subscriber %ss synchronously",
      (action) => {
        const observed: unknown[][] = [];
        let armed = true;
        gateway.subscribeEventLog((events) => {
          if (!armed || events.length > 0) {
            return;
          }
          armed = false;
          if (action === "replace") {
            gateway.connect({ gatewayUrl: C_URL });
          } else {
            current().opts.onEvent?.(B_EVENT);
          }
        });
        gateway.subscribeEventLog((events) => observed.push(events.map((event) => event.payload)));

        gateway.connect({ gatewayUrl: B_URL });

        expect(observed).toEqual(action === "record" ? [[B_EVENT.payload]] : [[]]);
        expect(gateway.eventLog.map((event) => event.payload)).toEqual(
          action === "record" ? [B_EVENT.payload] : [],
        );
        expect(store.clients[1]?.started).toBe(action === "record" ? 1 : 0);
        if (action === "replace") {
          expect(gateway.connection.gatewayUrl).toBe(C_URL);
          expect(current().started).toBe(1);
        }
      },
    );

    it.each(["connecting", "account retirement"] as const)(
      "publishes retirement without reviving a client stopped by its %s observer",
      (phase) => {
        const retired = current();
        const observed = vi.fn<(events: readonly EventLogEntry[]) => void>();
        const connectedScopes: Array<string | undefined> = [];
        gateway.subscribeEventLog(observed);
        gateway.subscribe((snapshot) => {
          if (snapshot.phase === "connected") {
            connectedScopes.push(snapshot.hello?.auth?.recoveryScope);
          }
          if (
            phase === "connecting" &&
            snapshot.phase === "connecting" &&
            gateway.connection.gatewayUrl === B_URL
          ) {
            gateway.stop();
          }
        });
        gateway.subscribeEventLog((events) => {
          if (phase === "account retirement" && events.length === 0) {
            gateway.stop();
          }
        });

        if (phase === "connecting") {
          gateway.connect({ gatewayUrl: B_URL });
          expect(store.clients[1]?.started).toBe(0);
        } else {
          retired.opts.onHello?.(hello("account-b"));
        }

        expect(observed).toHaveBeenLastCalledWith([]);
        expect(connectedScopes).toEqual([]);
        expect(gateway.snapshot.phase).toBe("stopped");
        expect(gateway.eventLog).toEqual([]);
      },
    );
  });

  it("clears persisted transcripts on credential change but not an unchanged reconnect", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("location", new URL("http://control.test/"));
    const sessionKey = 'scope:["ws://control.test","account-a"]\u0000agent:main:credential-scope';
    const snapshots = new SessionSnapshotStore();
    snapshots.write(sessionKey, {
      messages: ["private transcript"],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "credential-session",
    });
    const peerKey = 'scope:["ws://control.test","account-b"]\u0000agent:main:peer';
    snapshots.write(peerKey, {
      messages: ["peer transcript"],
      sessionId: "peer-session",
      pagination: { hasMore: false, completeSnapshot: true },
    });
    await snapshots.flush();
    const settings = { ...loadSettings(), gatewayUrl: "ws://control.test", token: "old-token" };
    const peerRecord: BootRecord = {
      version: 2,
      scope: settings.gatewayUrl,
      authMethod: "token",
      credential: "peer-fingerprint",
      recoveryScope: "account-b",
      profileId: "peer-profile",
      savedAt: Date.now(),
      agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
      groups: [],
      sectionOrder: [],
    };
    const peerBootKey = "openclaw.control.bootRecord.v1:" + settings.gatewayUrl;
    ({ gateway, current } = createStore({ settings }));
    try {
      gateway.connect();
      current().opts.onHello?.(hello("account-a"));
      localStorage.setItem(peerBootKey, JSON.stringify(peerRecord));
      expect(await new SessionSnapshotStore().read(sessionKey)).not.toBeNull();
      gateway.connect({ token: "" });
      await vi.waitFor(async () => {
        expect(await new SessionSnapshotStore().read(sessionKey)).toBeNull();
      });
      expect((await new SessionSnapshotStore().read(peerKey))?.messages).toEqual([
        "peer transcript",
      ]);
      expect(localStorage.getItem(peerBootKey)).toBe(JSON.stringify(peerRecord));
    } finally {
      await clearStoredChatSnapshots();
    }
  });
});

describe("canvas capability renewal", () => {
  beforeEach(() => {
    stubGatewayStoreTestGlobals();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([{ scopes: ["operator.sessions.write"] }])(
    "does not renew a canvas capability without operator read access: $scopes",
    async ({ scopes }) => {
      const { gateway, current } = createStore();
      gateway.start();
      current().request.mockRejectedValue(
        new GatewayRequestError({ code: "FORBIDDEN", message: "missing scope: operator.read" }),
      );
      const helloUrl = "https://canvas.test/__openclaw__/cap/hello";
      current().opts.onHello?.({
        ...HELLO,
        auth: { role: "operator", scopes },
        pluginSurfaceUrls: { canvas: helloUrl },
      });
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(57 * 60_000);

      const refreshes = current().request.mock.calls.filter(
        ([method]) => method === "plugin.surface.refresh",
      );
      expect(gateway.snapshot.canvasPluginSurfaceUrl).toBe(helloUrl);
      gateway.stop();
      expect(refreshes).toHaveLength(0);
    },
  );

  it.each(["operator.read"])(
    "renews with %s and stops after a reconnect without read access",
    async (scope) => {
      const { gateway, current } = createStore();
      gateway.start();
      const helloUrl = "https://canvas.test/__openclaw__/cap/hello";
      const refreshedUrl = "https://canvas.test/__openclaw__/cap/refreshed";
      current().request.mockImplementation(async (method) => {
        if (method === "users.self") {
          return { profile: { id: "reader", emails: [] } };
        }
        return {
          surface: "canvas",
          pluginSurfaceUrls: { canvas: refreshedUrl },
          expiresAtMs: Date.now() + 60_000,
        };
      });
      current().opts.onHello?.({
        ...HELLO,
        auth: { role: "operator", scopes: [scope] },
        pluginSurfaceUrls: { canvas: helloUrl },
      });
      await vi.dynamicImportSettled();
      expect(gateway.snapshot.canvasPluginSurfaceUrl).toBe(refreshedUrl);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(
        current().request.mock.calls.filter(([method]) => method === "plugin.surface.refresh"),
      ).toHaveLength(2);

      current().opts.onClose?.({ code: 1006, reason: "reconnect", willRetry: true });
      current().request.mockClear();
      current().opts.onHello?.({
        ...HELLO,
        pluginSurfaceUrls: { canvas: helloUrl },
      });
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(57 * 60_000);
      const refreshes = current().request.mock.calls.filter(
        ([method]) => method === "plugin.surface.refresh",
      );
      gateway.stop();
      expect(refreshes).toHaveLength(0);
    },
  );
});
