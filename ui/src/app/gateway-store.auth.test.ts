// @vitest-environment node
import { setImmediate as nextTurn } from "node:timers/promises";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { EventLogEntry } from "../api/event-log.ts";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import type { GatewayHelloOk } from "../api/gateway.ts";
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
  const accept = (value = HELLO, client = current()) => client.testOptions.onHello?.(value);
  const emit = (event = A_EVENT) => current().testOptions.onEvent?.(event);
  const payloads = () => gateway.eventLog.map((entry) => entry.payload);
  const disconnect = () =>
    current().testOptions.onClose?.({ code: 1006, reason: "lost", willRetry: true });

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
    accept({ ...HELLO, snapshot: { authMode: "token" } });
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
    expect(current().testOptions).toMatchObject({
      url: configured,
      token: "configured-credential",
    });
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

    accept({ ...HELLO, snapshot: { authMode: "password" } });
    expect(loadSettings().token).toBe("");
    expect(gateway.connection.token).toBe(secret);
    expect(write).not.toHaveBeenCalled();

    // Late hello from a replaced client must not persist its submitted secret.
    gateway.connect({ token: "replacement-secret" });
    accept({ ...HELLO, snapshot: { authMode: "token" } }, retired);
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

  function rejectStaleBuild(
    {
      gatewayBuildId,
      code = "UNAVAILABLE",
      socketCode = 1008,
    }: { gatewayBuildId?: string; code?: string; socketCode?: number } = {
      gatewayBuildId: "replacement-build",
    },
  ) {
    current().testOptions.onClose?.(
      rejection(
        { code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH, gatewayBuildId, reloadRequired: true },
        code,
        "Control UI updated",
        socketCode,
      ),
    );
  }

  it.each([undefined, "serving-build"])(
    "reloads a protocol rejection once with server build %s",
    async (gatewayBuildId) => {
      vi.useFakeTimers();
      const { replace, fetchMock } = stubBuildReloadDocument();
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
      gateway.start();
      rejectStaleBuild({ gatewayBuildId, code: "INVALID_REQUEST", socketCode: 1002 });
      await vi.advanceTimersByTimeAsync(0);
      expect(replace).toHaveBeenCalledOnce();
      expect(gateway.snapshot.phase).toBe("stopped");
      expect(sessionStorage.getItem(RELOAD_GUARD_KEY)).not.toBeNull();
    },
  );

  it.each([
    { previousBuild: "replacement-build", age: 120_000 },
    { previousBuild: "another-build", age: 59_000 },
  ])(
    "stops a repeated mismatch without scheduling another reload: %j",
    async ({ previousBuild, age }) => {
      vi.useFakeTimers();
      const { replace, fetchMock } = stubBuildReloadDocument();
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
      sessionStorage.setItem(
        RELOAD_GUARD_KEY,
        JSON.stringify({ buildId: previousBuild, at: Date.now() - age }),
      );
      gateway.start();
      rejectStaleBuild();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(replace).not.toHaveBeenCalled();
      expect(gateway.snapshot.phase).toBe("reload-required");
      expect(gateway.snapshot.lastErrorCode).toBe(ConnectErrorDetailCodes.PROTOCOL_MISMATCH);
    },
  );

  it.each([
    { action: "resume", jitter: 0, elapsed: 1_000, reloads: 1 },
    { action: "stop during initial jitter", jitter: 0.5, elapsed: 30_000, reloads: 0 },
    { action: "stop during probe retry", jitter: 0, elapsed: 30_000, reloads: 0 },
  ])("keeps build reload owned by the current connection: $action", async (scenario) => {
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
    expect(JSON.parse(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? "null")).toEqual(
      scenario.reloads ? { buildId: "replacement-build", at: expect.any(Number) } : null,
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
      expect(resumed).toMatchObject({
        pendingBootstrapToken: "replacement-bootstrap",
        pendingBootstrapProfile: "owner",
        location: { pathname: "/settings/appearance", hash: "#tab=keep" },
        settings: { token: "" },
      });
      expect(new URLSearchParams(resumed.location.search).get("keep")).toBe("yes");
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
    current().testOptions.onClose?.(
      rejection(
        { code: ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID },
        "INVALID_REQUEST",
        "unauthorized: bootstrap token invalid",
        4008,
      ),
    );
    gateway.connect({ token: "synthetic-replacement-secret" });

    expect(current().testOptions.token).toBe("synthetic-replacement-secret");
    expect(current().testOptions.bootstrapToken).toBeUndefined();
    expect(current().testOptions.bootstrapProfile).toBeUndefined();
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

  it("projects only a current recognized auth reason", () => {
    gateway.start();
    const rejected = rejection({
      code: ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
      authReason: "trusted_proxy_user_not_allowed",
    });
    current().testOptions.onClose?.(rejected);
    expect(gateway.snapshot.lastErrorAuthReason).toBe("trusted_proxy_user_not_allowed");

    const stale = current();
    gateway.connect();
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
    stale.testOptions.onClose?.(rejected);
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();

    current().testOptions.onClose?.(rejected);
    accept();
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
    current().testOptions.onClose?.(rejected);
    disconnect();
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
    current().testOptions.onClose?.(rejected);
    gateway.stop();
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
  });

  describe("diagnostic history ownership", () => {
    let stopDiagnostics: () => void;
    beforeEach(() => {
      stopDiagnostics = gateway.subscribeEventLog(() => {});
      gateway.start();
      accept(hello("account-a"));
      emit();
    });
    it("captures immutable history only while diagnostics is subscribed", () => {
      stopDiagnostics();
      const idleHistory = gateway.eventLog;
      const delivered = vi.fn();
      gateway.subscribeEvents(delivered);
      emit();
      expect(gateway.eventLog).toBe(idleHistory);
      expect(gateway.eventLog).toEqual([]);
      expect(delivered).toHaveBeenCalledExactlyOnceWith(A_EVENT);

      const observed = vi.fn();
      const stopFirst = gateway.subscribeEventLog(observed);
      const stopSecond = gateway.subscribeEventLog(() => {});
      emit();
      const captured = gateway.eventLog;
      stopFirst();
      emit(B_EVENT);
      expect(observed).toHaveBeenCalledOnce();
      expect(captured.map((entry) => entry.payload)).toEqual([A_EVENT.payload]);
      expect(payloads()).toEqual([B_EVENT.payload, A_EVENT.payload]);

      stopSecond();
      expect(gateway.eventLog).toEqual([]);
      expect(gateway.eventLogRevision).toBe(0);
      const stopReopened = gateway.subscribeEventLog(observed);
      expect(gateway.eventLog).toEqual([]);
      emit(B_EVENT);
      expect(payloads()).toEqual([B_EVENT.payload]);
      stopReopened();
    });

    it("retires old payloads before connecting with a changed shared token", () => {
      const oldClient = current();
      const observed = vi.fn<(events: readonly EventLogEntry[]) => void>();
      gateway.subscribeEventLog(observed);

      gateway.connect({ token: "synthetic-replacement-token" });

      expect(gateway.eventLog).toEqual([]);
      expect(observed).toHaveBeenLastCalledWith([]);
      expect(gateway.eventLogRevision).toBe(1);
      oldClient.testOptions.onEvent?.(A_EVENT);
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
          accept();
        }
        Object.defineProperty(current(), "recoveryScope", { value: recoveryScope });
        current().testOptions.onRecoveryScopeChange?.();
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
      disconnect();
      accept(hello("account-b"));

      expect(gateway.snapshot.selfUser).toBeNull();
      expect(gateway.connectionRevision).toBe(0);
      expect(gateway.eventLog).toEqual([]);
      expect(gateway.eventLogRevision).toBe(1);
      expect(observed).toHaveBeenLastCalledWith([]);

      emit(B_EVENT);
      accept(hello("account-b"));
      current().testOptions.onRecoveryScopeChange?.();
      expect(payloads()).toEqual([B_EVENT.payload]);
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
            emit(B_EVENT);
          }
        });
        gateway.subscribeEventLog((events) => observed.push(events.map((event) => event.payload)));

        gateway.connect({ gatewayUrl: B_URL });

        expect(observed).toEqual(action === "record" ? [[B_EVENT.payload]] : [[]]);
        expect(payloads()).toEqual(action === "record" ? [B_EVENT.payload] : []);
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
          accept(hello("account-b"), retired);
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
      accept(hello("account-a"));
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
  const helloUrl = "https://canvas.test/__openclaw__/cap/hello";
  const refreshedUrl = "https://canvas.test/__openclaw__/cap/refreshed";
  const acceptCanvas = (scopes?: string[]) =>
    accept({
      ...HELLO,
      ...(scopes ? { auth: { role: "operator", scopes } } : {}),
      pluginSurfaceUrls: { canvas: helloUrl },
    });
  const refreshes = () =>
    current().request.mock.calls.filter(([method]) => method === "plugin.surface.refresh");

  it("does not renew a canvas capability without operator read access", async () => {
    vi.useFakeTimers();
    gateway.start();
    current().request.mockRejectedValue(
      new GatewayRequestError({ code: "FORBIDDEN", message: "missing scope: operator.read" }),
    );
    acceptCanvas(["operator.sessions.write"]);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(57 * 60_000);
    expect(gateway.snapshot.canvasPluginSurfaceUrl).toBe(helloUrl);
    expect(refreshes()).toHaveLength(0);
  });

  it("renews with operator.read and stops after a reconnect without read access", async () => {
    vi.useFakeTimers();
    gateway.start();
    current().request.mockImplementation(async (method) =>
      method === "users.self"
        ? { profile: { id: "reader", emails: [] } }
        : {
            surface: "canvas",
            pluginSurfaceUrls: { canvas: refreshedUrl },
            expiresAtMs: Date.now() + 60_000,
          },
    );
    acceptCanvas(["operator.read"]);
    await vi.dynamicImportSettled();
    expect(gateway.snapshot.canvasPluginSurfaceUrl).toBe(refreshedUrl);
    disconnect();
    current().request.mockClear();
    acceptCanvas();
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(57 * 60_000);
    expect(refreshes()).toHaveLength(0);
  });
});
