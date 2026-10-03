// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../../lib/sessions/route-navigation.ts";
import { loadChatRoute, sessionRouteTargetFromLocation } from "./route-loader.ts";
import {
  createSessionRouteContext,
  createSessionRouteRow,
  installShortSessionResolver,
  sessionRouteListResult,
} from "./route-resolution.test-support.ts";

function warmRoute(scope: "per-sender" | "global" = "per-sender", mainKey = "workspace") {
  const fixture = createSessionRouteContext();
  const { context } = fixture;
  const connectedClient = context.gateway.snapshot.client;
  const listeners = new Set<Parameters<ApplicationContext["gateway"]["subscribe"]>[0]>();
  const waiting = createDeferred();
  context.gateway.snapshot.phase = "connecting";
  context.gateway.snapshot.client = null;
  context.gateway.subscribe = vi.fn((listener) => {
    listeners.add(listener);
    waiting.resolve();
    return () => listeners.delete(listener);
  });
  context.agents.state.agentsList = null;
  Object.defineProperty(context.sessions, "cachedRoutingDefaults", {
    get: () => (context.gateway.snapshot.phase === "connected" ? undefined : { mainKey, scope }),
  });
  const cache = createDeferred();
  context.sessions.whenCachedRosterSettled = vi.fn(() => cache.promise);
  return {
    ...fixture,
    cache,
    waiting: waiting.promise,
    connect(this: void) {
      context.gateway.snapshot.phase = "connected";
      context.gateway.snapshot.client = connectedClient;
      Object.assign(context.gateway.snapshot, {
        hello: {
          snapshot: {
            sessionDefaults: { defaultAgentId: "roboclaw", mainKey: "workspace", scope },
          },
        },
      });
      for (const listener of listeners) {
        listener(context.gateway.snapshot);
      }
    },
    installResolver: (rows: GatewaySessionRow[]) => {
      context.gateway.snapshot.client = connectedClient;
      const request = installShortSessionResolver(context, rows);
      context.gateway.snapshot.client = null;
      return request;
    },
  };
}

describe("cached session route startup", () => {
  it("waits for live routing defaults before resolving a shorthand main route", async () => {
    const { context, request, connect, waiting } = warmRoute();
    const completed = vi.fn();
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/roboclaw", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    ).then(completed);
    await waiting;
    expect(completed).not.toHaveBeenCalled();
    connect();
    await pending;
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "session", sessionKey: "agent:roboclaw:workspace" }),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a global main route waiting for hello", async () => {
    const { context, connect, waiting } = warmRoute("global");
    const completed = vi.fn();
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/roboclaw", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    ).then(completed);

    await waiting;
    expect(completed).not.toHaveBeenCalled();
    connect();
    await pending;
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ kind: "session" }));
  });

  it("resolves a global-scope literal route once hello makes its defaults authoritative", async () => {
    const { context, connect, installResolver, waiting } = warmRoute("global");
    const row = createSessionRouteRow({ key: "agent:roboclaw:thread" });
    const request = installResolver([row]);
    const completed = vi.fn();
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/thread", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    ).then(completed);

    await waiting;
    expect(completed).not.toHaveBeenCalled();
    connect();
    await pending;
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "session", sessionKey: row.key }),
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("resolves a cached short route before requesting a Gateway client without agent discovery", async () => {
    const { context, cache, request, waiting } = warmRoute();
    const row = createSessionRouteRow({ displayName: "Cached conversation" });
    const controller = new AbortController();
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/cached-conversation-12345678", search: "", hash: "" },
      "chat",
      controller.signal,
    );
    context.sessions.state.result = sessionRouteListResult([row]);
    context.sessions.state.resultCached = true;
    cache.resolve();
    try {
      expect(
        await Promise.race([pending, waiting.then(() => "waiting for Gateway")]),
      ).toMatchObject({
        kind: "session",
        sessionKey: row.key,
        sessionResolutionFromCache: true,
      });
      expect(context.agents.state.agentsList).toBeNull();
      expect(request).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await pending.catch(() => undefined);
    }
  });

  it("keeps a configured main key that resembles a short link literal before hello", () => {
    const { context } = warmRoute("per-sender", "cached-conversation-12345678");
    expect(
      sessionRouteTargetFromLocation(context, {
        pathname: "/chat/roboclaw/cached-conversation-12345678",
        search: "",
        hash: "",
      })?.target,
    ).toMatchObject({
      kind: "literal",
      sessionKey: "agent:roboclaw:cached-conversation-12345678",
    });
  });

  it("preserves cached session rows while waiting for live routing defaults", async () => {
    const { context, request, connect, waiting } = warmRoute();
    const sessionKey = "agent:roboclaw:thread";
    context.sessions.state.result = sessionRouteListResult([
      createSessionRouteRow({ key: sessionKey, displayName: "Cached conversation" }),
    ]);
    context.sessions.state.resultCached = true;
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/thread", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );
    await waiting;
    expect(context.sessions.state.result?.sessions[0]?.displayName).toBe("Cached conversation");
    expect(request).not.toHaveBeenCalled();
    connect();
    expect(await pending).toMatchObject({ kind: "session", sessionKey });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["missing", "ambiguous", "global", "preference"] as const)(
    "keeps %s cached short resolution on the Gateway path",
    async (scenario) => {
      const { context, cache, connect, installResolver, waiting } = warmRoute(
        scenario === "global" ? "global" : "per-sender",
      );
      const row = createSessionRouteRow({ displayName: "Cached conversation" });
      const duplicate = createSessionRouteRow({
        key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
        displayName: "Cached conversation",
      });
      context.sessions.state.result = sessionRouteListResult(
        scenario === "missing" ? [] : scenario === "ambiguous" ? [row, duplicate] : [row],
      );
      context.sessions.state.resultCached = true;
      const request = installResolver([row]);
      cache.resolve();
      const completed = vi.fn();
      const pending = loadChatRoute(
        context,
        {
          pathname: "/chat/roboclaw/cached-conversation-12345678",
          search: scenario === "preference" ? `?${SESSION_FACE_PREFERENCE_PARAM}=1` : "",
          hash: "",
        },
        "chat",
        new AbortController().signal,
      ).then(completed);

      await waiting;
      expect(completed).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      connect();
      await pending;
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "session",
          sessionKey: row.key,
        }),
      );
      expect(request).toHaveBeenCalledOnce();
    },
  );
});
