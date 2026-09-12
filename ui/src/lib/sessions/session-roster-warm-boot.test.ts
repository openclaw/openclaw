import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
/* @vitest-environment node */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { BootRecord } from "../../app/boot-record.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapability } from "./index.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import type { SessionCapability, SessionGateway } from "./session-capability.ts";
import type { SessionRosterRecord } from "./session-roster-cache.ts";

const url = "ws://gateway.example.test";
const scope = gatewayCredentialScope(url);
const bootRecord: BootRecord = {
  version: 2,
  authMethod: "token",
  credential: "9d17676d",
  savedAt: 1,
  scope,
  profileId: "profile-one",
  agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  groups: [{ name: "Work", position: 0 }],
  sectionOrder: ["category:Work"],
};
function roster(): SessionRosterRecord {
  return {
    version: 1,
    scope,
    savedAt: Date.now(),
    profileId: "profile-one",
    agentId: "main",
    query: {},
    result: sessionsResult(
      [
        {
          key: "agent:main:deleted",
          sessionId: "deleted",
          kind: "direct",
          agentId: "main",
          derivedTitle: "Removed later",
        },
        {
          key: "agent:main:kept",
          sessionId: "kept",
          kind: "direct",
          agentId: "main",
          derivedTitle: "Stale title",
          lastMessagePreview: "Stale preview",
        },
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
});

function harness(
  options: {
    cached?: Promise<SessionRosterRecord | null>;
    withBootRecord?: boolean;
    bundledBootstrap?: boolean;
  } = {},
) {
  let connectionRevision = 0;
  let snapshot: SessionGateway["snapshot"] = {
    client: null,
    phase: "connecting",
    hello: null,
    sessionKey: "agent:main:deleted",
    selfUser: null,
  };
  const listeners = new Set<(value: typeof snapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const live = createDeferred<SessionsListResult>();
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.subscribe") {
      return options.bundledBootstrap
        ? { subscribed: true, list: await live.promise }
        : { subscribed: true };
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
  const read = vi.fn(() => options.cached ?? Promise.resolve(roster()));
  const write = vi.fn();
  const selection = { state: { selectedId: "main" }, subscribe: () => () => undefined };
  const sessions = createSessionCapability(gateway, selection, {
    rosterCache: { read, write },
    ...(options.withBootRecord !== false ? { bootRecord } : {}),
  });
  activeCapabilities.add(sessions);
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener(snapshot));
  };
  return {
    sessions,
    read,
    write,
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

describe("session capability warm roster", () => {
  it.each([10, 30])(
    "preserves event ordering during cached startup (event updatedAt: %s)",
    async (updatedAt) => {
      const h = harness();
      await h.sessions.whenCachedRosterSettled();
      h.connect();
      await vi.waitFor(() =>
        expect(h.request).toHaveBeenCalledWith("sessions.list", expect.anything()),
      );
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

  it("publishes groups synchronously, then the cached roster without a connection or canonical revision", async () => {
    const cached = createDeferred<SessionRosterRecord | null>();
    const h = harness({ cached: cached.promise });
    expect(h.sessions.state.groups).toEqual(["Work"]);
    expect(h.sessions.state.result).toBeNull();
    let settled = false;
    void h.sessions.whenCachedRosterSettled().then(() => {
      settled = true;
    });
    await vi.dynamicImportSettled();
    expect(settled).toBe(false);
    cached.resolve(roster());
    await h.sessions.whenCachedRosterSettled();
    expect(settled).toBe(true);
    expect(h.sessions.state).toMatchObject({
      result: roster().result,
      resultCached: true,
      agentId: "main",
    });
    expect(h.sessions.canonicalListRevision).toBe(0);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    h.publish({ phase: "reconnecting" });
    expect(h.sessions.state.result?.sessions).toHaveLength(2);
    expect(h.sessions.state.resultCached).toBe(true);
  });

  it("does not read or publish a cached roster without an accepted boot record", async () => {
    const h = harness({ withBootRecord: false });
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
    const live = sessionsResult([{ key: "agent:main:live", kind: "direct" }], 2);
    h.live.resolve(live);
    await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
    expect(h.sessions.state.resultCached).toBe(false);
  });

  it.each([false, true])(
    "replaces cached presentation while retaining a newer live observation: %s",
    async (observeWhileLoading) => {
      const h = harness();
      await h.sessions.whenCachedRosterSettled();
      h.connect();
      await vi.waitFor(() =>
        expect(h.request).toHaveBeenCalledWith("sessions.list", expect.anything()),
      );
      expect(h.write).not.toHaveBeenCalled();
      const live = sessionsResult(
        [{ key: "agent:main:kept", sessionId: "kept", kind: "direct" }],
        2,
      );
      const observed = observeWhileLoading
        ? { ...live.sessions[0]!, label: "Confirmed live name" }
        : undefined;
      if (observed) {
        expect(h.sessions.captureReconcile()(observed)).toBe(true);
        expect(h.sessions.state.result?.sessions).toHaveLength(2);
        expect(h.sessions.state.resultCached).toBe(true);
        expect(h.write).not.toHaveBeenCalled();
      }
      h.live.resolve(live);
      await vi.waitFor(() => expect(h.sessions.state.resultCached).toBe(false));
      const expected = observed ? { ...live, sessions: [observed] } : live;
      expect(h.sessions.state.result).toEqual(expected);
      expect(h.sessions.canonicalListRevision).toBe(1);
      expect(h.write).toHaveBeenCalledWith(
        expect.objectContaining({
          scope,
          profileId: "profile-one",
          agentId: "main",
          result: expected,
        }),
      );
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
      const h = harness({ bundledBootstrap: true });
      const canonical = {
        key: "agent:main:live",
        sessionId: "live",
        kind: "direct" as const,
      };
      const live = sessionsResult([canonical], 2);
      try {
        await h.sessions.whenCachedRosterSettled();
        h.connect();
        await vi.waitFor(() =>
          expect(h.request).toHaveBeenCalledWith(
            "sessions.subscribe",
            expect.anything(),
            expect.anything(),
          ),
        );
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
        expect(h.write).not.toHaveBeenCalled();

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
      let subscriptions = 0;
      h.request.mockImplementation(async (method) => {
        if (method === "sessions.subscribe") {
          subscriptions += 1;
          return {
            subscribed: true,
            list: await (subscriptions === 1 ? h.live.promise : replacement.promise),
          };
        }
        if (method === "sessions.list") {
          return replacement.promise;
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
        await vi.waitFor(() => expect(subscriptions).toBe(1));
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
        await vi.waitFor(() => expect(subscriptions).toBe(2));
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
        if (source === "event") {
          // A second consumer must not recapture the old payload in this connection.
          expect(h.sessions.reconcileChanged(previous).applied).toBe(false);
        }
        const accepted = h.sessions.state.result?.sessions.find((row) => row.key === key);
        expect(accepted?.label).toBe(observeAfterReconnect ? current.label : previous.label);
        expect(h.write).not.toHaveBeenCalled();

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

  it.each(["trusted-proxy", "password", "tailscale", "bootstrap-token", "none"] as const)(
    "does not persist live rows for %s authentication",
    async (method) => {
      const h = harness({ withBootRecord: false });
      h.connect("profile-one", method);
      const live = sessionsResult([{ key: "agent:main:private", kind: "direct" }], 2);
      h.live.resolve(live);
      await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
      expect(h.write).not.toHaveBeenCalled();
    },
  );

  it("drops a mismatched profile before bootstrap asks for its live rows", async () => {
    const h = harness();
    await h.sessions.whenCachedRosterSettled();
    h.connect("profile-two");
    expect(h.sessions.state.result).toBeNull();
    expect(h.sessions.state.groups).toEqual([]);
    expect(h.sessions.state.resultCached).toBe(false);
    const live = sessionsResult([{ key: "agent:main:new-profile", kind: "direct" }], 2);
    h.live.resolve(live);
    await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-two", result: live }),
    );
  });

  it.each(["connect", "dispose", "credentials", "credentials-before-notification"] as const)(
    "does not publish a late cache read after %s",
    async (transition) => {
      const cached = createDeferred<SessionRosterRecord | null>();
      const h = harness({ cached: cached.promise });
      if (transition === "connect") {
        h.connect();
      } else if (transition === "dispose") {
        h.sessions.dispose();
      } else {
        h.changeCredentials();
        if (transition === "credentials") {
          h.publish({ phase: "connecting" });
          expect(h.sessions.state.groups).toEqual([]);
        }
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
      const cached = createDeferred<SessionRosterRecord | null>();
      const h = harness({ cached: cached.promise });
      const settled = h.sessions.whenCachedRosterSettled();
      if (transition === "connect") {
        h.connect();
      } else {
        h.sessions.dispose();
      }
      await expect(
        Promise.race([
          settled.then(() => "released"),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("held"), 200);
          }),
        ]),
      ).resolves.toBe("released");
      cached.resolve(roster());
      await settled;
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
      const live = sessionsResult([{ key: "agent:main:other", kind: "direct" }], 2);
      h.live.resolve(live);
      await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
      h.publish({ sessionKey: "agent:main:other" });
      expect(h.sessions.state.result).toEqual(live);
      expect(h.write).toHaveBeenCalledWith(
        expect.objectContaining({ scope: gatewayCredentialScope(nextUrl) }),
      );
    },
  );

  it.each(["agent", "profile", "query", "query-agent"] as const)(
    "rejects an incompatible %s from an injected roster reader",
    async (mismatch) => {
      const invalid = roster();
      if (mismatch === "agent") {
        invalid.agentId = "other";
      }
      if (mismatch === "profile") {
        invalid.profileId = "other";
      }
      if (mismatch === "query") {
        invalid.query = { archivedFilter: "archived" };
      }
      if (mismatch === "query-agent") {
        invalid.query = { agentId: "other" };
      }
      const h = harness({ cached: Promise.resolve(invalid) });
      await h.sessions.whenCachedRosterSettled();
      expect(h.sessions.state.result).toBeNull();
    },
  );
});
