// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadChatRoute, sessionRouteTargetFromLocation } from "./route-loader.ts";
import {
  createSessionRouteContext,
  createSessionRouteRow,
  installShortSessionResolver,
  sessionRouteListResult,
} from "./route-resolution.test-support.ts";

const shortName = "cached-conversation-12345678";
const location = (pathname: string) => ({ pathname, search: "", hash: "" });

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
    seed: (rows: GatewaySessionRow[]) => {
      context.sessions.state.result = sessionRouteListResult(rows);
      context.sessions.state.resultCached = true;
    },
    waiting: waiting.promise,
    load: (pathname: string, signal = new AbortController().signal) => {
      const face = pathname.startsWith("/dashboard/") ? "dashboard" : "chat";
      return loadChatRoute(context, location(pathname), face, signal);
    },
    connect(this: void) {
      context.gateway.snapshot.phase = "connected";
      context.gateway.snapshot.client = connectedClient;
      const sessionDefaults = { defaultAgentId: "roboclaw", mainKey: "workspace", scope };
      Object.assign(context.gateway.snapshot, { hello: { snapshot: { sessionDefaults } } });
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

it.each([
  ["chat", "exact"],
  ["chat", "literal"],
  ["chat", "short"],
  ["dashboard", "short"],
  ["chat", "title"],
  ["dashboard", "title"],
] as const)("loads cached %s/%s without Gateway discovery", async (face, mode) => {
  const { context, seed, cache, request, waiting, load } = warmRoute();
  const exact = mode === "exact";
  const literal = mode === "literal";
  const dashboardId = "12345678-90ab-cdef-1234-567890abcdef";
  const row = createSessionRouteRow({
    ...(exact ? { key: `agent:roboclaw:dashboard:${dashboardId}` } : {}),
    ...(literal ? { key: "agent:roboclaw:thread" } : {}),
    displayName: exact ? "Cached dashboard" : "Cached conversation",
  });
  const suffix = {
    exact: `dashboard/${dashboardId}`,
    literal: "thread",
    short: shortName,
    title: "cached-conversation",
  }[mode];
  if (literal) {
    seed([row]);
  }
  const controller = new AbortController();
  const completed = vi.fn();
  const pending = load(`/${face}/roboclaw/${suffix}`, controller.signal).then((result) => {
    completed(result);
    return result;
  });
  try {
    if (exact) {
      await Promise.resolve();
      await Promise.resolve();
      expect(completed).not.toHaveBeenCalled();
    }
    if (!literal) {
      seed([row]);
    }
    cache.resolve();
    if (literal) {
      expect(context.sessions.state.result?.sessions[0]?.displayName).toBe("Cached conversation");
      expect(request).not.toHaveBeenCalled();
    }
    expect(await Promise.race([pending, waiting.then(() => "waiting for Gateway")])).toMatchObject({
      kind: "session",
      sessionKey: row.key,
      ...(!exact && !literal ? { sessionResolutionFromCache: true } : {}),
    });
    expect(context.agents.state.agentsList).toBeNull();
    expect(request).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await pending.catch(() => undefined);
  }
});

it("keeps a configured main key that resembles a short link literal before hello", () => {
  const { context } = warmRoute("per-sender", shortName);
  expect(
    sessionRouteTargetFromLocation(context, location(`/chat/roboclaw/${shortName}`))?.target,
  ).toMatchObject({ kind: "literal", sessionKey: "agent:roboclaw:cached-conversation-12345678" });
});

it.each(["global literal", "uncached short"] as const)(
  "waits for Gateway resolution: %s",
  async (route) => {
    const literal = route === "global literal";
    const { seed, cache, connect, installResolver, waiting, load } = warmRoute(
      literal ? "global" : "per-sender",
    );
    const row = createSessionRouteRow(
      literal ? { key: "agent:roboclaw:thread" } : { displayName: "Cached conversation" },
    );
    if (!literal) {
      seed([]);
    }
    const request = installResolver([row]);
    if (!literal) {
      cache.resolve();
    }
    const completed = vi.fn();
    const pending = load(`/chat/roboclaw/${literal ? "thread" : shortName}`).then(completed);
    await waiting;
    expect(completed).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    connect();
    await pending;
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "session", sessionKey: row.key }),
    );
    expect(request).toHaveBeenCalledOnce();
  },
);
