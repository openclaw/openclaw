import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
/* @vitest-environment node */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { clearBootRecords, type BootRecord } from "../../app/boot-record.ts";
import * as snapshotPrewarm from "../../pages/chat/session-snapshot-prewarm.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sidebarBootSnapshot } from "../../test-helpers/sidebar-boot-snapshot.test-support.ts";
import { createSessionCapability } from "./index.ts";
import type { BootRoster } from "./session-boot-roster.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import type { SessionCapability, SessionGateway } from "./session-capability.ts";

const url = "ws://gateway.example.test";
const scope = gatewayCredentialScope(url);
const bootRecord: BootRecord = {
  version: 2,
  recoveryScope: "test-recovery-scope",
  authMethod: "token",
  credential: "9d17676d",
  savedAt: 1,
  scope,
  profileId: "profile-one",
  agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  groups: [{ name: "Work", position: 0 }],
  sectionOrder: ["category:Work"],
};
function directRow(name: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key: `agent:main:${name}`, kind: "direct", ...fields };
}

function roster(): BootRoster {
  return {
    agentId: "main",
    result: sessionsResult(
      [
        directRow("deleted", {
          sessionId: "deleted",
          agentId: "main",
          derivedTitle: "Removed later",
        }),
        directRow("kept", {
          sessionId: "kept",
          agentId: "main",
          derivedTitle: "Stale title",
          lastMessagePreview: "Stale preview",
        }),
      ],
      1,
    ),
    groups: ["Work"],
    groupSettings: bootRecord.groups,
    sectionOrder: bootRecord.sectionOrder,
  };
}
const activeCapabilities = new Set<SessionCapability>();
afterEach(() => {
  for (const sessions of activeCapabilities) {
    sessions.dispose();
  }
  activeCapabilities.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function harness(
  options: {
    cached?: Promise<BootRoster | null>;
    withBootRecord?: boolean;
    admittedRecord?: BootRecord;
    retainedHelloScope?: string;
  } = {},
) {
  let connectionRevision = 0;
  let snapshot: SessionGateway["snapshot"] = {
    client: null,
    phase: "connecting",
    hello: options.retainedHelloScope
      ? {
          type: "hello-ok",
          protocol: 1,
          auth: { role: "operator", scopes: [], recoveryScope: options.retainedHelloScope },
        }
      : null,
    sessionKey: "agent:main:deleted",
    selfUser: null,
  };
  const listeners = new Set<(value: typeof snapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const live = createDeferred<SessionsListResult>();
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      return live.promise;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const gateway: SessionGateway = {
    connection: { gatewayUrl: url, token: "test-token" },
    get connectionRevision() {
      return connectionRevision;
    },
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
  const read = vi.spyOn(snapshotPrewarm, "readSidebarBootSnapshot").mockImplementation(async () => {
    const cached = await (options.cached ?? Promise.resolve(roster()));
    return cached ? sidebarBootSnapshot(cached) : null;
  });
  const selection = { state: { selectedId: "main" }, subscribe: () => () => undefined };
  const sessions = createSessionCapability(
    gateway,
    selection,
    options.withBootRecord !== false ? { bootRecord: options.admittedRecord ?? bootRecord } : {},
  );
  activeCapabilities.add(sessions);
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener(snapshot));
  };
  return {
    sessions,
    read,
    request,
    live,
    gateway,
    publish,
    emitChanged(payload: unknown) {
      eventListeners.forEach((listener) =>
        listener({ type: "event", event: "sessions.changed", payload, seq: 1 }),
      );
    },
    changeCredentials() {
      connectionRevision += 1;
    },
    connect(
      profileId = "profile-one",
      method:
        | "token"
        | "device-token"
        | "trusted-proxy"
        | "password"
        | "tailscale"
        | "bootstrap-token"
        | "none"
        | undefined = "token",
    ) {
      publish({
        phase: "connected",
        client,
        selfUser: { id: profileId },
        hello: {
          type: "hello-ok",
          protocol: 1,
          auth: { method, deviceToken: "test-token", role: "operator", scopes: ["operator.read"] },
        },
      });
    },
  };
}

async function connectCached(h: ReturnType<typeof harness>) {
  await h.sessions.whenCachedRosterSettled();
  h.connect();
  await vi.waitFor(() =>
    expect(h.request).toHaveBeenCalledWith("sessions.list", expect.anything()),
  );
}

describe("session capability warm roster", () => {
  it.each(["client", "profile", "credentials", "gateway", "stop"])(
    "retains canonical display identity through transport loss, then retires it on %s",
    async (retirement) => {
      const h = harness({ withBootRecord: false });
      h.connect();
      const live = sessionsResult([directRow("retained")], 2);
      h.live.resolve(live);
      await h.sessions.refresh();
      expect(h.sessions.presentation.result).toEqual(live);
      expect(h.sessions.presentation.resultCached).not.toBe(true);
      expect(h.sessions.presentation.profileId).toBe("profile-one");
      const requestCount = h.request.mock.calls.length;
      h.publish({ phase: "reconnecting", selfUser: undefined });
      expect(h.sessions.state.result).toBeNull();
      expect(h.sessions.presentation.result).toEqual(live);
      expect(h.sessions.presentation.profileId).toBe("profile-one");
      expect(h.request).toHaveBeenCalledTimes(requestCount);
      if (retirement === "client") {
        h.publish({ client: createTestGatewayClient(h.request) });
      } else if (retirement === "profile") {
        h.connect("profile-two");
      } else if (retirement === "stop") {
        h.publish({ client: null, phase: "stopped" });
      } else {
        if (retirement === "gateway") {
          Object.defineProperty(h.gateway, "connection", {
            value: { gatewayUrl: "ws://other.example.test", token: "test-token" },
          });
        } else {
          h.changeCredentials();
        }
        h.publish({ phase: "connecting" });
      }
      expect(h.sessions.presentation.result).toBeNull();
      expect(h.sessions.presentation.profileId).toBeUndefined();
      h.sessions.dispose();
    },
  );

  it("retires the captured account even with a different live hello identity", async () => {
    const h = harness({ retainedHelloScope: "live-account" });
    await h.sessions.whenCachedRosterSettled();
    expect(h.sessions.state.resultCached).toBe(true);
    clearBootRecords(scope, { recoveryScope: "other-account" });
    expect(h.sessions.state.resultCached).toBe(true);
    clearBootRecords(scope, { recoveryScope: bootRecord.recoveryScope! });
    expect(h.sessions.state.resultCached).toBe(false);
    expect(h.sessions.state.result).toBeNull();
    expect(h.sessions.state.groups).toEqual([]);
  });

  it.each(["pending", "published"])(
    "keeps its %s roster through unrelated owner retirement",
    async (stage) => {
      const cached = createDeferred<BootRoster | null>();
      const h = harness({ cached: cached.promise });
      if (stage === "published") {
        cached.resolve(roster());
        await h.sessions.whenCachedRosterSettled();
      }
      clearBootRecords(scope, { recoveryScope: "different-owner" });
      cached.resolve(roster());
      await h.sessions.whenCachedRosterSettled();
      expect(h.sessions.state.resultCached).toBe(true);
      expect(h.sessions.state.result).toEqual(roster().result);
      expect(h.sessions.state.groups).toEqual(["Work"]);
      expect(h.request).not.toHaveBeenCalled();
      clearBootRecords(scope, { recoveryScope: bootRecord.recoveryScope! });
      expect(h.sessions.state.result).toBeNull();
      expect(h.sessions.state.resultCached).toBe(false);
      expect(h.sessions.state.groups).toEqual([]);
    },
  );

  it.each([10, 30])(
    "preserves event ordering during cached startup (event updatedAt: %s)",
    async (updatedAt) => {
      const h = harness();
      await connectCached(h);
      const history = {
        key: "agent:main:kept",
        sessionId: "kept",
        kind: "direct" as const,
        updatedAt: 20,
        label: "History name",
        archived: false,
      };
      const reconcile = h.sessions.captureReconcile();
      try {
        h.emitChanged({ ...history, updatedAt, label: "Event name" });
        expect(
          h.sessions.state.result?.sessions.find((row) => row.key === history.key)?.label,
        ).toBe("Event name");
        reconcile(history);
        expect(
          h.sessions.state.result?.sessions.find((row) => row.key === history.key),
        ).toMatchObject({
          label: updatedAt > history.updatedAt ? "Event name" : history.label,
          updatedAt: Math.max(updatedAt, history.updatedAt),
        });
      } finally {
        h.sessions.dispose();
        h.live.resolve(sessionsResult([history], 2));
      }
    },
  );

  it.each(["frame", "background", "connect", "dispose"] as const)(
    "publishes the cached roster before yielding past paint and releases on %s",
    async (release) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const queued = createDeferred<FrameRequestCallback>();
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        queued.resolve(callback);
        return 1;
      });
      const cancelFrame = vi.fn();
      vi.stubGlobal("cancelAnimationFrame", cancelFrame);
      const cached = createDeferred<BootRoster | null>();
      const h = harness({ cached: cached.promise });
      const settlement = h.sessions.whenCachedRosterSettled();
      const settled = vi.fn();
      void settlement.then(settled);
      try {
        expect(h.sessions.cachedRoutingDefaults).toEqual({ mainKey: "main", scope: "per-sender" });
        expect(h.sessions.state.groups).toEqual(["Work"]);
        expect(h.sessions.state.result).toBeNull();
        cached.resolve(roster());
        const frame = await Promise.race([
          queued.promise,
          settlement.then(() => {
            throw new Error("Cached route settled before yielding to a browser frame");
          }),
        ]);
        expect(settled).not.toHaveBeenCalled();
        expect(h.sessions.state).toMatchObject({
          result: roster().result,
          resultCached: true,
          agentId: "main",
        });
        expect(h.sessions.canonicalListRevision).toBe(0);
        expect(h.request).not.toHaveBeenCalled();
        expect(h.sessions.captureBootRoster()).toBeNull();
        if (release === "connect" || release === "dispose") {
          if (release === "connect") {
            h.connect();
          } else {
            h.sessions.dispose();
          }
          await Promise.resolve();
          expect(settled).toHaveBeenCalledOnce();
          expect(h.sessions.cachedRoutingDefaults).toBeUndefined();
        }
        const currentResult = h.sessions.state.result;
        if (release === "frame") {
          frame(16);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          // rAF callbacks precede paint; routing must wait for the following task.
          expect(settled).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(0);
        } else {
          await vi.advanceTimersByTimeAsync(100);
          expect(cancelFrame).toHaveBeenCalledWith(1);
        }
        await settlement;
        expect(settled).toHaveBeenCalledOnce();
        expect(h.sessions.state.result).toBe(currentResult);
        if (release === "frame" || release === "background") {
          h.publish({ phase: "reconnecting" });
          expect(h.sessions.state.result?.sessions).toHaveLength(2);
          expect(h.sessions.state.resultCached).toBe(true);
        }
      } finally {
        h.sessions.dispose();
        cached.resolve(null);
        h.live.resolve(sessionsResult([], 2));
      }
    },
  );

  it("does not read or publish a cached roster without an accepted boot record", async () => {
    const h = harness({ withBootRecord: false });
    expect(h.sessions.cachedRoutingDefaults).toBeUndefined();
    await h.sessions.whenCachedRosterSettled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.sessions.state).toMatchObject({
      result: null,
      groups: [],
      groupSettings: [],
      sectionOrder: [],
    });
    expect(h.sessions.state.resultCached).not.toBe(true);
    expect(h.sessions.canonicalListRevision).toBe(0);
    h.publish({ phase: "reconnecting" });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.sessions.state.result).toBeNull();

    h.connect();
    const live = sessionsResult([directRow("live")], 2);
    h.live.resolve(live);
    await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
    expect(h.sessions.state.resultCached).toBe(false);
  });

  it.each([false, true])(
    "replaces cached presentation while retaining a newer live observation: %s",
    async (observeWhileLoading) => {
      const h = harness();
      await connectCached(h);
      expect(h.sessions.captureBootRoster()).toBeNull();
      const live = sessionsResult([directRow("kept", { sessionId: "kept" })], 2);
      const observed = observeWhileLoading
        ? { ...live.sessions[0]!, label: "Confirmed live name" }
        : undefined;
      if (observed) {
        expect(h.sessions.captureReconcile()(observed)).toBe(true);
        expect(h.sessions.state.result?.sessions).toHaveLength(2);
        expect(h.sessions.state.resultCached).toBe(true);
        expect(h.sessions.captureBootRoster()).toBeNull();
      }
      h.live.resolve(live);
      await vi.waitFor(() => expect(h.sessions.state.resultCached).toBe(false));
      const expected = observed ? { ...live, sessions: [observed] } : live;
      expect(h.sessions.state.result).toEqual(expected);
      expect(h.sessions.canonicalListRevision).toBe(1);
      expect(h.sessions.captureBootRoster()).toMatchObject({
        agentId: "main",
        result: expected,
      });
    },
  );

  it.each([
    { source: "read", selected: true },
    { source: "read", selected: false },
    { source: "event", selected: true },
    { source: "event", selected: false },
  ] as const)(
    "keeps omitted $source rows only for the selected session during bootstrap: $selected",
    async ({ source, selected }) => {
      const h = harness();
      const canonical = directRow("live", { sessionId: "live" });
      const live = sessionsResult([canonical], 2);
      try {
        await connectCached(h);
        const observed = {
          key: selected ? "agent:main:deleted" : "agent:main:kept",
          sessionId: selected ? "deleted" : "kept",
          kind: "direct" as const,
          updatedAt: 3,
          label: "Confirmed live descriptor",
          archived: source === "read" || selected,
          status: "done" as const,
          hasActiveRun: false,
        };
        if (source === "read") {
          expect(
            h.sessions.captureReconcile()(observed, undefined, { archivedFilter: "all" }),
          ).toBe(true);
        } else {
          h.emitChanged(observed);
        }
        const accepted = h.sessions.state.result?.sessions.find((row) => row.key === observed.key);
        expect(accepted).toMatchObject(observed);
        expect(h.sessions.state.resultCached).toBe(true);
        expect(h.sessions.captureBootRoster()).toBeNull();

        h.live.resolve(live);
        await vi.waitFor(() => expect(h.sessions.state.resultCached).toBe(false));
        const expected = selected ? [canonical, accepted] : [canonical];
        expect(h.sessions.state.result?.sessions).toEqual(expected);
        expect(h.sessions.state.result?.count).toBe(expected.length);
        expect(h.sessions.canonicalListRevision).toBe(1);
      } finally {
        h.sessions.dispose();
        h.live.resolve(live);
      }
    },
  );

  it.each([
    { source: "read", observeAfterReconnect: false },
    { source: "event", observeAfterReconnect: false },
    { source: "read", observeAfterReconnect: true },
    { source: "event", observeAfterReconnect: true },
  ] as const)(
    "retires cached $source evidence across reconnect unless observed again: $observeAfterReconnect",
    async ({ source, observeAfterReconnect }) => {
      const h = harness();
      const replacement = createDeferred<SessionsListResult>();
      let lists = 0;
      h.request.mockImplementation(async (method) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.list") {
          lists += 1;
          return lists === 1 ? h.live.promise : replacement.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const key = "agent:main:deleted";
      const previous = {
        key,
        sessionId: "deleted",
        kind: "direct" as const,
        agentId: "main",
        updatedAt: 3,
        label: "Previous connection",
        archived: true,
        status: "done" as const,
        hasActiveRun: false,
      };
      const canonical = sessionsResult([], 4);
      try {
        await h.sessions.whenCachedRosterSettled();
        h.connect();
        await vi.waitFor(() => expect(lists).toBe(1));
        const retiredReconcile = h.sessions.captureReconcile();
        if (source === "read") {
          expect(retiredReconcile(previous, undefined, { archivedFilter: "all" })).toBe(true);
        } else {
          h.emitChanged(previous);
        }
        expect(h.sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject(
          previous,
        );
        expect(h.sessions.state.resultCached).toBe(true);

        h.publish({ phase: "reconnecting" });
        h.connect();
        await vi.waitFor(() => expect(lists).toBe(2));
        expect(retiredReconcile(previous, undefined, { archivedFilter: "all" })).toBe(false);
        const current = { ...previous, label: "Current connection", status: "failed" as const };
        if (observeAfterReconnect) {
          if (source === "read") {
            expect(
              h.sessions.captureReconcile()(current, undefined, { archivedFilter: "all" }),
            ).toBe(true);
          } else {
            h.emitChanged(current);
          }
        }
        const accepted = h.sessions.state.result?.sessions.find((row) => row.key === key);
        expect(accepted?.label).toBe(observeAfterReconnect ? current.label : previous.label);
        expect(h.sessions.captureBootRoster()).toBeNull();

        h.live.resolve(sessionsResult([previous], 3));
        await Promise.resolve();
        expect(h.sessions.state.resultCached).toBe(true);
        replacement.resolve(canonical);
        await vi.waitFor(() => expect(h.sessions.state.resultCached).toBe(false));
        expect(h.sessions.state.result?.sessions).toEqual(observeAfterReconnect ? [accepted] : []);
      } finally {
        h.sessions.dispose();
        h.live.resolve(canonical);
        replacement.resolve(canonical);
      }
    },
  );

  it("drops a mismatched profile before bootstrap asks for its live rows", async () => {
    const h = harness();
    await h.sessions.whenCachedRosterSettled();
    h.connect("profile-two");
    expect(h.sessions.state.result).toBeNull();
    expect(h.sessions.state.groups).toEqual([]);
    expect(h.sessions.state.resultCached).toBe(false);
    const live = sessionsResult([directRow("new-profile")], 2);
    h.live.resolve(live);
    await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
    expect(h.sessions.captureBootRoster()?.result).toEqual(live);
  });

  it.each(["credentials", "credentials-before-notification"] as const)(
    "does not publish a late cache read after %s",
    async (transition) => {
      const cached = createDeferred<BootRoster | null>();
      const h = harness({ cached: cached.promise });
      h.changeCredentials();
      expect(h.sessions.cachedRoutingDefaults).toBeUndefined();
      if (transition === "credentials") {
        h.publish({ phase: "connecting" });
        expect(h.sessions.state.groups).toEqual([]);
      }
      cached.resolve(roster());
      await h.sessions.whenCachedRosterSettled();
      expect(h.sessions.state.result).toBeNull();
      expect(h.sessions.state.resultCached).not.toBe(true);
    },
  );

  it.each(["connect", "dispose"] as const)(
    "releases the roster wait on %s while the cache read is still pending",
    async (transition) => {
      const cached = createDeferred<BootRoster | null>();
      const h = harness({ cached: cached.promise });
      const settled = h.sessions.whenCachedRosterSettled();
      if (transition === "connect") {
        h.connect();
      } else {
        h.sessions.dispose();
      }
      expect(h.sessions.cachedRoutingDefaults).toBeUndefined();
      await expect(settled).resolves.toBeUndefined();
      cached.resolve(roster());
      await settled;
      expect(h.sessions.state.result).toBeNull();
      expect(h.sessions.state.resultCached).not.toBe(true);
    },
  );

  it.each(["gateway", "credentials"])(
    "retires the warm roster on a %s change and retains replacement live rows",
    async (change) => {
      const h = harness();
      await h.sessions.whenCachedRosterSettled();
      expect(h.sessions.state.resultCached).toBe(true);
      expect(h.sessions.state.result?.sessions).toHaveLength(2);
      const nextUrl = change === "gateway" ? "ws://other.example.test" : url;
      if (change === "gateway") {
        Object.defineProperty(h.gateway, "connection", {
          value: { gatewayUrl: nextUrl, token: "test-token" },
        });
      } else {
        h.changeCredentials();
      }
      expect(h.sessions.cachedRoutingDefaults).toBeUndefined();
      h.publish({ phase: "connecting" });
      expect(h.sessions.state).toMatchObject({
        result: null,
        resultCached: false,
        agentId: null,
        groups: [],
        groupSettings: [],
        sectionOrder: [],
      });
      h.publish({ phase: "offline" });
      expect(h.sessions.state.result).toBeNull();
      h.connect();
      const live = sessionsResult([directRow("other")], 2);
      h.live.resolve(live);
      await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
      h.publish({ sessionKey: "agent:main:other" });
      expect(h.sessions.state.result).toEqual(live);
      expect(h.sessions.captureBootRoster()?.result).toEqual(live);
    },
  );
});
