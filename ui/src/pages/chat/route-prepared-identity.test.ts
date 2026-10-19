// @vitest-environment node
import type { ModelsSnapshotEvent, SessionsResolveResult } from "@openclaw/gateway-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  createSessionRouteContext,
  sessionRouteKey,
  sessionRouteListResult,
} from "./route-resolution.test-support.ts";

const location = { pathname: "/chat/roboclaw/original-title-12345678", search: "", hash: "" };
const target = { agentId: "roboclaw", shortId: "12345678", slugHint: "original-title" };
const publication: ModelsSnapshotEvent = {
  target,
  scope: { agentId: "roboclaw", sessionKey: sessionRouteKey },
  catalog: { models: [] },
};
const resolved: SessionsResolveResult = {
  ok: true,
  key: sessionRouteKey,
  agentId: "roboclaw",
  displayName: "Current title",
};
const otherKey = "agent:roboclaw:thread:12345678-1111-4111-8111-111111111111";
const otherPrefix = "agent:roboclaw:thread:87654321-90ab-cdef-1234-567890abcdef";

function session(data: Awaited<ReturnType<typeof loadChatRoute>>) {
  if (!("kind" in data) || data.kind !== "session") {
    throw new Error("Expected a resolved chat route");
  }
  return data;
}
function fixture() {
  const harness = createSessionRouteContext();
  const reply = createDeferred<SessionsResolveResult>();
  const requestStarted = createDeferred();
  const controller = new AbortController();
  harness.context.gateway.snapshot.hello = gatewayHelloForMethods([
    "sessions.resolve",
    "sessions.subscribe",
    "sessions.list",
  ]);
  harness.context.gateway.snapshot.selfUser = { id: "reader" };
  harness.request.mockImplementation(async (method) => {
    if (method === "sessions.resolve") {
      requestStarted.resolve();
      return reply.promise;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      return sessionRouteListResult([]);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const emit = (payload: ModelsSnapshotEvent = publication) =>
    harness.publishEvent({ type: "event", event: "models.snapshot", payload });

  const started = () => requestStarted.promise;
  const load = () => loadChatRoute(harness.context, location, "chat", controller.signal);
  const start = async (prepare = false) => {
    let settled = false;
    const pending = load().then((data) => {
      settled = true;
      return data;
    });
    await started();
    if (prepare) {
      emit();
    }
    return { pending, settled: () => settled };
  };
  const expectCanonical = async (canonical: typeof location | null | undefined, calls: number) => {
    if (!canonical) {
      throw new Error("Expected a canonical session location");
    }
    await expect(
      loadChatRoute(harness.context, canonical, "chat", new AbortController().signal),
    ).resolves.toMatchObject({ kind: "session", sessionKey: sessionRouteKey });
    expect(
      harness.request.mock.calls.filter(([method]) => method === "sessions.resolve"),
    ).toHaveLength(calls);
  };
  const ownerChanges = {
    client: () => harness.publishGateway({ client: null }),
    hello: () => harness.publishGateway({ hello: gatewayHelloForMethods(["sessions.resolve"]) }),
    profile: () => harness.publishGateway({ selfUser: { id: "other-reader" } }),
    disconnect: () => harness.publishGateway({ phase: "reconnecting" }),
    navigation: () => controller.abort(),
    application: () => harness.stop(),
  };
  const replaceOwner = (change: keyof typeof ownerChanges) => ownerChanges[change]();
  return {
    ...harness,
    reply,
    emit,
    started,
    start,
    load,
    replaceOwner,
    expectCanonical,
    baseline: harness.listenerCounts(),
  };
}

describe("prepared short-route identity", () => {
  let h: ReturnType<typeof fixture>;
  beforeEach(() => {
    h = fixture();
  });
  it.each(["prepared event", "RPC response"] as const)(
    "reuses canonical identity from a %s when the original route began before hello",
    async (source) => {
      const { client, hello } = h.context.gateway.snapshot;
      h.publishGateway({ phase: "connecting", client: null, hello: null });
      const waiting = createDeferred();
      const subscribe = h.context.gateway.subscribe;
      vi.spyOn(h.context.gateway, "subscribe").mockImplementation((listener) => {
        const stop = subscribe(listener);
        waiting.resolve();
        return stop;
      });
      const pending = h.load();
      await waiting.promise;
      h.publishGateway({ phase: "connected", client, hello });
      await h.started();
      if (source === "prepared event") {
        h.emit();
      } else {
        h.reply.resolve(resolved);
      }
      const data = session(await pending);
      h.reply.resolve(resolved);
      const canonical = data.canonicalLocation ?? (await data.canonicalLocationReady);
      expect(canonical?.pathname).toBe("/chat/roboclaw/current-title-12345678");
      await h.expectCanonical(canonical, 1);
    },
  );

  it.each(["hello", "profile", "disconnect", "navigation", "application"] as const)(
    "retires late canonicalization after a prepared route loses its %s owner",
    async (change) => {
      const { pending } = await h.start(true);
      const data = session(await pending);
      const original = { ...h.context.gateway.snapshot };
      h.replaceOwner(change);
      h.publishGateway(original);
      expect(h.listenerCounts()).toEqual(h.baseline);
      h.reply.resolve(resolved);
      expect(await data.canonicalLocationReady).toBeNull();
      expect(data.sessionKey).toBe(sessionRouteKey);
      expect(h.listenerCounts()).toEqual(h.baseline);
    },
  );

  it.each([
    ["conflicting key", { ...resolved, key: otherKey }],
    ["conflicting agent", { ...resolved, agentId: "other" }],
  ] satisfies Array<[string, SessionsResolveResult]>)(
    "accepts prepared identity without canonicalizing a later %s reply",
    async (_name, reply) => {
      const { pending } = await h.start(true);
      const data = session(await pending);
      expect(data).toMatchObject({
        kind: "session",
        sessionKey: sessionRouteKey,
        routeLoadingSkeleton: true,
      });
      expect(data).not.toHaveProperty("canonicalLocation");
      expect(h.listenerCounts().events).toBe(h.baseline.events);
      h.reply.resolve(reply);
      expect(await data.canonicalLocationReady).toBeNull();
      h.emit({ ...publication, scope: { agentId: "other", sessionKey: "agent:other:main" } });
      expect(data.sessionKey).toBe(sessionRouteKey);
      expect(h.listenerCounts()).toEqual(h.baseline);
    },
  );

  it.each([
    ["different target", { target: { ...target, slugHint: "other" } }],
    ["different agent", { scope: { ...publication.scope, agentId: "other" } }],
    ["different prefix", { scope: { agentId: "roboclaw", sessionKey: otherPrefix } }],
    ["agent-only catalog", { scope: { agentId: "roboclaw" } }],
  ] satisfies Array<[string, Partial<ModelsSnapshotEvent>]>)(
    "keeps the ordinary resolver for %s",
    async (_name, event) => {
      const { pending, settled } = await h.start();
      h.emit({ ...publication, ...event });
      await Promise.resolve();
      expect(settled()).toBe(false);
      h.reply.resolve(resolved);
      expect(await pending).toMatchObject({ kind: "session", sessionKey: sessionRouteKey });
      expect(h.listenerCounts()).toEqual(h.baseline);
    },
  );

  it.each([
    ["missing-session", { ok: false }],
    ["ambiguous", { ok: false, candidates: [{ key: sessionRouteKey, agentId: "roboclaw" }] }],
  ] satisfies Array<[string, SessionsResolveResult]>)(
    "preserves the normal %s result when no prepared identity arrives",
    async (kind, reply) => {
      const { pending } = await h.start();
      h.reply.resolve(reply);
      expect(await pending).toMatchObject({ kind });
      h.emit();
      expect(await pending).toMatchObject({ kind });
    },
  );

  it.each(["client", "hello", "profile", "disconnect"] as const)(
    "retires resolution identity on %s replacement before it arrives",
    async (change) => {
      const { pending, settled } = await h.start();
      const original = { ...h.context.gateway.snapshot };
      h.replaceOwner(change);
      expect(h.listenerCounts()).toEqual(h.baseline);
      h.emit();
      await Promise.resolve();
      expect(settled()).toBe(false);
      h.publishGateway(original);
      h.reply.resolve(resolved);
      const data = session(await pending);
      await h.expectCanonical(data.canonicalLocation, 2);
    },
  );

  it("rechecks source authority after the event wins but before it publishes a route", async () => {
    const { pending } = await h.start();
    h.emit();
    h.publishGateway({ selfUser: { id: "replacement-reader" } });
    h.reply.resolve({ ...resolved, key: otherKey });
    expect(await pending).toMatchObject({ sessionKey: otherKey });
  });

  it.each(["navigation", "application"] as const)("cleans up when %s is aborted", async (owner) => {
    const pending = h.load();
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await h.started();
    h.replaceOwner(owner);
    await rejected;
    expect(h.listenerCounts()).toEqual(h.baseline);
    h.emit();
    h.reply.resolve(resolved);
  });
});
