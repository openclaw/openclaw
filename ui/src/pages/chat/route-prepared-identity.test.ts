// @vitest-environment node
import type { ModelsSnapshotEvent, SessionsResolveResult } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
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

function fixture() {
  const harness = createSessionRouteContext();
  const reply = createDeferred<SessionsResolveResult>();
  const controller = new AbortController();
  harness.context.gateway.snapshot.hello = gatewayHelloForMethods([
    "sessions.resolve",
    "sessions.subscribe",
    "sessions.list",
  ]);
  harness.context.gateway.snapshot.selfUser = { id: "reader" };
  harness.request.mockImplementation(async (method) => {
    if (method === "sessions.resolve") {
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
  const started = () =>
    vi.waitFor(() =>
      expect(
        harness.request.mock.calls.filter(([method]) => method === "sessions.resolve"),
      ).toHaveLength(1),
    );
  return { ...harness, reply, controller, emit, started };
}

describe("prepared short-route identity", () => {
  it("reuses canonical identity when the original route began before hello", async () => {
    const h = fixture();
    const { client, hello } = h.context.gateway.snapshot;
    h.publishGateway({ phase: "connecting", client: null, hello: null });
    const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
    await vi.waitFor(() => expect(h.listenerCounts().gateway).toBeGreaterThan(1));
    h.publishGateway({ phase: "connected", client, hello });
    await h.started();
    h.emit();
    const data = await pending;
    if (!("kind" in data) || data.kind !== "session") {
      throw new Error("Expected a resolved chat route");
    }
    h.reply.resolve(resolved);
    const canonical = await data.canonicalLocationReady;
    expect(canonical?.pathname).toBe("/chat/roboclaw/current-title-12345678");
    if (!canonical) {
      throw new Error("Expected a canonical location");
    }
    await expect(
      loadChatRoute(h.context, canonical, "chat", new AbortController().signal),
    ).resolves.toMatchObject({ kind: "session", sessionKey: sessionRouteKey });
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.resolve")).toHaveLength(
      1,
    );
  });

  it.each(["hello", "profile", "disconnect", "navigation", "application"] as const)(
    "retires late canonicalization after a prepared route loses its %s owner",
    async (change) => {
      const h = fixture();
      const baseline = h.listenerCounts();
      const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
      await h.started();
      h.emit();
      const data = await pending;
      if (!("kind" in data) || data.kind !== "session") {
        throw new Error("Expected a resolved chat route");
      }
      const original = { ...h.context.gateway.snapshot };
      if (change === "hello") {
        h.publishGateway({ hello: gatewayHelloForMethods(["sessions.resolve"]) });
      } else if (change === "profile") {
        h.publishGateway({ selfUser: { id: "other-reader" } });
      } else if (change === "disconnect") {
        h.publishGateway({ phase: "reconnecting" });
      } else if (change === "navigation") {
        h.controller.abort();
      } else {
        h.stop();
      }
      h.publishGateway(original);
      expect(h.listenerCounts()).toEqual(baseline);
      h.reply.resolve(resolved);
      expect(await data.canonicalLocationReady).toBeNull();
      expect(data.sessionKey).toBe(sessionRouteKey);
      expect(h.listenerCounts()).toEqual(baseline);
    },
  );

  it.each([
    { name: "matching identity", reply: resolved, canonical: true },
    {
      name: "conflicting key",
      reply: { ...resolved, key: "agent:roboclaw:thread:12345678-1111-4111-8111-111111111111" },
      canonical: false,
    },
    { name: "conflicting agent", reply: { ...resolved, agentId: "other" }, canonical: false },
    { name: "missing", reply: { ok: false }, canonical: false },
    {
      name: "ambiguous",
      reply: { ok: false, candidates: [{ key: sessionRouteKey, agentId: "roboclaw" }] },
      canonical: false,
    },
    { name: "error", reply: new Error("Resolution failed"), canonical: false },
  ] satisfies Array<{ name: string; reply: SessionsResolveResult | Error; canonical: boolean }>)(
    "accepts identity now and only canonicalizes a later $name reply when compatible",
    async ({ reply, canonical }) => {
      const h = fixture();
      const baseline = h.listenerCounts();
      const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
      await h.started();
      h.emit();
      const data = await pending;
      expect(data).toMatchObject({
        kind: "session",
        sessionKey: sessionRouteKey,
        routeLoadingSkeleton: true,
      });
      expect(data).not.toHaveProperty("canonicalLocation");
      expect(h.listenerCounts().events).toBe(baseline.events);
      if (!("kind" in data) || data.kind !== "session") {
        throw new Error("Expected a resolved chat route");
      }
      if (reply instanceof Error) {
        h.reply.reject(reply);
      } else {
        h.reply.resolve(reply);
      }
      expect(await data.canonicalLocationReady).toEqual(
        canonical ? { ...location, pathname: "/chat/roboclaw/current-title-12345678" } : null,
      );
      h.emit({ ...publication, scope: { agentId: "other", sessionKey: "agent:other:main" } });
      expect(data.sessionKey).toBe(sessionRouteKey);
      expect(h.listenerCounts()).toEqual(baseline);
    },
  );

  it.each([
    { name: "no event" },
    {
      name: "different target",
      event: { ...publication, target: { ...target, slugHint: "other" } },
    },
    {
      name: "different agent",
      event: { ...publication, scope: { ...publication.scope, agentId: "other" } },
    },
    {
      name: "different prefix",
      event: {
        ...publication,
        scope: {
          agentId: "roboclaw",
          sessionKey: "agent:roboclaw:thread:87654321-90ab-cdef-1234-567890abcdef",
        },
      },
    },
    { name: "agent-only catalog", event: { ...publication, scope: { agentId: "roboclaw" } } },
  ] satisfies Array<{ name: string; event?: ModelsSnapshotEvent }>)(
    "keeps the ordinary resolver for $name",
    async ({ event }) => {
      const h = fixture();
      const baseline = h.listenerCounts();
      let settled = false;
      const pending = loadChatRoute(h.context, location, "chat", h.controller.signal).then(
        (data) => {
          settled = true;
          return data;
        },
      );
      await h.started();
      if (event) {
        h.emit(event);
      }
      await Promise.resolve();
      expect(settled).toBe(false);
      h.reply.resolve(resolved);
      expect(await pending).toMatchObject({ kind: "session", sessionKey: sessionRouteKey });
      expect(h.listenerCounts()).toEqual(baseline);
    },
  );

  it.each([
    { name: "missing", reply: { ok: false }, kind: "missing-session" },
    {
      name: "ambiguous",
      reply: { ok: false, candidates: [{ key: sessionRouteKey, agentId: "roboclaw" }] },
      kind: "ambiguous",
    },
  ] satisfies Array<{ name: string; reply: SessionsResolveResult; kind: string }>)(
    "preserves the normal $name result when no prepared identity arrives",
    async ({ reply, kind }) => {
      const h = fixture();
      const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
      await h.started();
      h.reply.resolve(reply);
      expect(await pending).toMatchObject({ kind });
      h.emit();
      expect(await pending).toMatchObject({ kind });
    },
  );

  it("keeps resolver errors visible and releases its listeners", async () => {
    const h = fixture();
    const baseline = h.listenerCounts();
    const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
    const rejected = expect(pending).rejects.toThrow("Resolution failed");
    await h.started();
    h.reply.reject(new Error("Resolution failed"));
    await rejected;
    expect(h.listenerCounts()).toEqual(baseline);
    h.emit();
  });

  it.each(["client", "hello", "profile", "disconnect"] as const)(
    "retires prepared identity on %s replacement before it arrives",
    async (change) => {
      const h = fixture();
      const baseline = h.listenerCounts();
      let settled = false;
      const pending = loadChatRoute(h.context, location, "chat", h.controller.signal).then(
        (data) => {
          settled = true;
          return data;
        },
      );
      await h.started();
      if (change === "client") {
        h.publishGateway({ client: null });
      } else if (change === "hello") {
        h.publishGateway({ hello: gatewayHelloForMethods(["sessions.resolve"]) });
      } else if (change === "profile") {
        h.publishGateway({ selfUser: { id: "other-reader" } });
      } else {
        h.publishGateway({ phase: "reconnecting" });
      }
      expect(h.listenerCounts()).toEqual(baseline);
      h.emit();
      await Promise.resolve();
      expect(settled).toBe(false);
      h.reply.resolve(resolved);
      await pending;
    },
  );

  it("rechecks source authority after the event wins but before it publishes a route", async () => {
    const h = fixture();
    const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
    await h.started();
    h.emit();
    h.publishGateway({ selfUser: { id: "replacement-reader" } });
    h.reply.resolve({
      ...resolved,
      key: "agent:roboclaw:thread:12345678-1111-4111-8111-111111111111",
    });
    expect(await pending).toMatchObject({
      sessionKey: "agent:roboclaw:thread:12345678-1111-4111-8111-111111111111",
    });
  });

  it.each(["navigation", "application"] as const)("cleans up when %s is aborted", async (owner) => {
    const h = fixture();
    const baseline = h.listenerCounts();
    const pending = loadChatRoute(h.context, location, "chat", h.controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await h.started();
    if (owner === "navigation") {
      h.controller.abort();
    } else {
      h.stop();
    }
    await rejected;
    expect(h.listenerCounts()).toEqual(baseline);
    h.emit();
    h.reply.resolve(resolved);
  });

  it.each([
    {
      name: "dashboard",
      face: "dashboard",
      location: { ...location, pathname: location.pathname.replace("/chat/", "/dashboard/") },
    },
    {
      name: "preferred face",
      face: "chat",
      location: { ...location, search: "?__openclawSessionFacePreference=1" },
    },
    { name: "draft query", face: "chat", location: { ...location, search: "?draft=hello" } },
    { name: "anchor", face: "chat", location: { ...location, hash: "#anchor" } },
  ] as const)("keeps full resolution for $name", async (entry) => {
    const h = fixture();
    const baseline = h.listenerCounts();
    const pending = loadChatRoute(h.context, entry.location, entry.face, h.controller.signal);
    await h.started();
    h.emit();
    expect(h.listenerCounts()).toEqual(baseline);
    h.reply.resolve({ ...resolved, boardFace: "dashboard" });
    const data = await pending;
    expect(data).toMatchObject({
      kind: "session",
      sessionKey: sessionRouteKey,
      face: entry.location.search.includes("__openclawSessionFacePreference")
        ? "dashboard"
        : entry.face,
    });
  });
});
