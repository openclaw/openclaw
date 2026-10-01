// @vitest-environment node
import { setImmediate as nextTurn } from "node:timers/promises";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { EventLogEntry } from "../api/event-log.ts";
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

  it.each(["token", "password"] as const)(
    "persists the submitted secret only after a token-mode hello (%s)",
    (authMode) => {
      const gatewayUrl = gateway.connection.gatewayUrl;
      const secret = "synthetic-gateway-secret";
      persistSessionToken(gatewayUrl, "previous-token");
      const write = vi.spyOn(sessionStorage, "setItem");
      gateway.connect({ token: secret });
      const retired = current();
      saveSettings({ ...loadSettings(), token: secret });
      expect(write).not.toHaveBeenCalled();
      expect(loadSettings().token).toBe("previous-token");

      current().opts.onHello?.({ ...HELLO, snapshot: { authMode } });
      expect(loadSettings().token).toBe(authMode === "token" ? secret : "");
      expect(gateway.connection.token).toBe(secret);
      if (authMode !== "token") {
        expect(write).not.toHaveBeenCalled();
      }

      // Late hello from a replaced client must not persist its submitted secret.
      gateway.connect({ token: "replacement-secret" });
      retired.opts.onHello?.({ ...HELLO, snapshot: { authMode: "token" } });
      expect(loadSettings().token).toBe(authMode === "token" ? secret : "");
    },
  );

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

  it("lets the current connection resume build recovery during the probe retry delay", async () => {
    vi.useFakeTimers();
    const { replace, fetchMock } = stubBuildReloadDocument();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    gateway.start();
    rejectStaleBuild();
    await vi.advanceTimersByTimeAsync(0);
    gateway.connect();
    rejectStaleBuild();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(replace).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe("replacement-build");
  });

  it("retires automatic build recovery when the connection stops between probes", async () => {
    vi.useFakeTimers();
    const { replace, fetchMock } = stubBuildReloadDocument();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    gateway.start();
    rejectStaleBuild();
    await vi.advanceTimersByTimeAsync(0);
    gateway.stop();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(replace).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull();
  });

  it("preserves an unfinished browser handoff across a build recovery reload", async () => {
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
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("HEAD");
    probe.resolve(new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    const destination = new URL(replace.mock.calls[0]![0]);
    const resumed = resolveApplicationStartupSettings(loadSettings(), destination);
    expect(resumed.pendingBootstrapToken).toBe(bootstrapToken);
    expect(resumed.pendingBootstrapProfile).toBe("owner");
    expect(resumed.location.pathname).toBe("/settings/appearance");
    expect(new URLSearchParams(resumed.location.search).get("keep")).toBe("yes");
    expect(resumed.location.hash).toBe("#tab=keep");
    expect(resumed.settings.token).toBe("");
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index++) {
        expect(storage.getItem(storage.key(index)!)).not.toContain(bootstrapToken);
      }
    }
  });

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

  it("lets the replacement handoff join the pending document probe for the same build", async () => {
    const { replace, probe, fetchMock } = stubBuildReloadDocument();
    gateway.connect({ bootstrapToken: "retired-bootstrap" });
    rejectStaleBuild();
    gateway.connect({ bootstrapToken: "replacement-bootstrap", bootstrapProfile: "owner" });
    rejectStaleBuild();
    expect(fetchMock).toHaveBeenCalledOnce();

    probe.resolve(new Response(null, { status: 200 }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    const resumed = resolveApplicationStartupSettings(
      loadSettings(),
      new URL(replace.mock.calls[0]![0]),
    );
    expect(resumed.pendingBootstrapToken).toBe("replacement-bootstrap");
    expect(resumed.pendingBootstrapProfile).toBe("owner");
  });

  it("does not finish a retired handoff probe after credentials change", async () => {
    const { replace, probe, fetchMock } = stubBuildReloadDocument();
    gateway.connect({ bootstrapToken: "synthetic-owner-bootstrap", bootstrapProfile: "owner" });
    rejectStaleBuild();
    expect(fetchMock).toHaveBeenCalledOnce();
    gateway.connect({ bootstrapToken: "replacement-bootstrap" });
    probe.resolve(new Response(null, { status: 200 }));
    await nextTurn();
    expect(replace).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull();
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

  it("does not project an unrecognized auth reason", () => {
    gateway.start();
    current().opts.onClose?.(
      rejection({ code: ConnectErrorDetailCodes.AUTH_UNAUTHORIZED, authReason: "unknown" }),
    );
    expect(gateway.snapshot.lastErrorAuthReason).toBeNull();
  });

  it("keeps proxy rejection reasons scoped to the current failed connection", () => {
    gateway.start();
    const rejected = rejection({
      code: ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
      authReason: "trusted_proxy_user_not_allowed",
    });
    current().opts.onClose?.(rejected);
    expect(gateway.snapshot.lastErrorAuthReason).toBe("trusted_proxy_user_not_allowed");

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

    it.each([
      ["shared token", { token: "synthetic-replacement-token" }],
      ["password", { password: "synthetic-replacement-password" }],
      ["bootstrap handoff", { bootstrapToken: "synthetic-bootstrap", bootstrapProfile: "owner" }],
    ] satisfies Array<[string, ApplicationGatewayConnectOptions]>)(
      "retires old payloads before connecting with a changed %s",
      (_name, overrides) => {
        const oldClient = current();
        const observed = vi.fn<(events: readonly EventLogEntry[]) => void>();
        gateway.subscribeEventLog(observed);

        gateway.connect(overrides);

        expect(gateway.eventLog).toEqual([]);
        expect(observed).toHaveBeenLastCalledWith([]);
        expect(gateway.eventLogRevision).toBe(1);
        oldClient.opts.onEvent?.(A_EVENT);
        expect(gateway.eventLog).toEqual([]);
      },
    );

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

    it("preserves authenticated history after a bootstrap handoff is consumed", () => {
      gateway.connect({ bootstrapToken: "synthetic-bootstrap", bootstrapProfile: "owner" });
      current().opts.onHello?.(hello("account-b"));
      current().opts.onEvent?.(B_EVENT);
      const history = gateway.eventLog;

      gateway.connect();
      current().opts.onHello?.(hello("account-b"));

      expect(gateway.connection.bootstrapToken).toBe("");
      expect(gateway.eventLog).toBe(history);
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

    it("publishes retirement when a connecting observer stops the new client", () => {
      const observed = vi.fn<(events: readonly EventLogEntry[]) => void>();
      gateway.subscribeEventLog(observed);
      gateway.subscribe((snapshot) => {
        if (snapshot.phase === "connecting" && gateway.connection.gatewayUrl === B_URL) {
          gateway.stop();
        }
      });

      gateway.connect({ gatewayUrl: B_URL });

      expect(observed).toHaveBeenLastCalledWith([]);
      expect(gateway.eventLog).toEqual([]);
      expect(store.clients[1]?.started).toBe(0);
    });

    it("does not publish an account hello after its retirement subscriber stops the client", () => {
      const retired = current();
      const connectedScopes: Array<string | undefined> = [];
      gateway.subscribe((snapshot) => {
        if (snapshot.phase === "connected") {
          connectedScopes.push(snapshot.hello?.auth?.recoveryScope);
        }
      });
      gateway.subscribeEventLog((events) => {
        if (events.length === 0) {
          gateway.stop();
        }
      });

      retired.opts.onHello?.(hello("account-b"));

      expect(connectedScopes).toEqual([]);
      expect(gateway.snapshot.phase).toBe("stopped");
      expect(gateway.eventLog).toEqual([]);
    });
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
