import { createRouter } from "@openclaw/uirouter";
import { expect, onTestFinished, vi } from "vitest";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import { registerListener } from "../../../../src/shared/listeners.js";
import type { GatewayEventListener } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  createTestSessionCapability,
  sessionsResult as sessionRouteListResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { loadChatRoute } from "./route-loader.ts";
export { sessionRouteListResult };

export function loadSessionRoute(
  context: Parameters<typeof loadChatRoute>[0],
  location: Parameters<typeof loadChatRoute>[1],
  face: Parameters<typeof loadChatRoute>[2] = "chat",
) {
  return loadChatRoute(context, location, face, new AbortController().signal);
}

export function canonicalSession(loaded: Awaited<ReturnType<typeof loadChatRoute>>) {
  if (!("kind" in loaded) || loaded.kind !== "session" || !loaded.canonicalLocation) {
    throw new Error("Expected a canonical session location");
  }
  return { ...loaded, canonicalLocation: loaded.canonicalLocation };
}

export const sessionRouteUuid = "12345678-90ab-cdef-1234-567890abcdef";
export const sessionRouteKey = `agent:roboclaw:thread:${sessionRouteUuid}`;

export function createSessionRouteRow(
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key: sessionRouteKey,
    kind: "direct",
    updatedAt: 1,
    displayName: "Default mode with rare surprises",
    sessionId: "fedcba98-7654-3210-fedc-ba9876543210",
    ...overrides,
  };
}

export function createSessionRouteContext(
  resolution: SessionsResolveResult | Error = { ok: false },
  cachedSessions: GatewaySessionRow[] = [],
  { agentId = "roboclaw", mainKey = "main" } = {},
) {
  const router = createRouter({ routes: [] });
  const lifecycle = new AbortController();
  const gatewayListeners = new Set<Parameters<ApplicationContext["gateway"]["subscribe"]>[0]>();
  const eventListeners = new Set<GatewayEventListener>();
  onTestFinished(() => {
    lifecycle.abort();
    router.stop();
    sessions.dispose();
    expect([gatewayListeners.size, eventListeners.size]).toEqual([0, 0]);
  });
  const request = vi.fn(async (method: string, _params: unknown): Promise<unknown> => {
    if (method !== "sessions.resolve") {
      throw new Error(`Unexpected gateway request: ${method}`);
    }
    if (resolution instanceof Error) {
      throw resolution;
    }
    return resolution;
  });
  const context = {
    basePath: "",
    chatSubmissions: createChatSubmissions(),
    placementStartup: { get: vi.fn(() => null) },
    // These tests invoke the loader directly; there is no outlet-owned match.
    router,
    lifecycleAbortSignal: lifecycle.signal,
    gateway: {
      snapshot: {
        phase: "connected",
        client: { request },
        hello: null,
        sessionKey: `agent:${agentId}:${mainKey}`,
      },
      subscribe: (listener: Parameters<ApplicationContext["gateway"]["subscribe"]>[0]) =>
        registerListener(gatewayListeners, listener),
      subscribeEvents: (listener: GatewayEventListener) =>
        registerListener(eventListeners, listener),
    },
    agents: { state: { agentsList: { mainKey } } },
    agentSelection: { state: { selectedId: agentId } },
  } as unknown as ApplicationContext;
  const sessions = createTestSessionCapability(context.gateway, agentId);
  sessions.state.result = sessionRouteListResult(cachedSessions);
  return {
    context: { ...context, sessions },
    list: vi.spyOn(sessions, "list"),
    request,
    listenerCounts: () => ({ gateway: gatewayListeners.size, events: eventListeners.size }),
    publishGateway: (patch: Partial<ApplicationContext["gateway"]["snapshot"]>) => {
      Object.assign(context.gateway.snapshot, patch);
      for (const listener of gatewayListeners) {
        listener(context.gateway.snapshot);
      }
    },
    publishEvent: (event: Parameters<GatewayEventListener>[0]) => {
      for (const listener of Array.from(eventListeners)) {
        listener(event);
      }
    },
    stop: () => lifecycle.abort(),
  };
}

export function installShortSessionResolver(
  context: ApplicationContext,
  rows: GatewaySessionRow[],
  resolved: { ok: true; key: string } | { ok: false; candidates?: Array<{ key: string }> } = rows[0]
    ? { ok: true, key: rows[0].key }
    : { ok: false },
) {
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "sessions.resolve") {
      const present = ({ key }: { key: string }) => {
        const session = rows.find((candidate) => candidate.key === key);
        return {
          key,
          agentId: session?.agentId ?? key.split(":")[1],
          ...(session?.displayName ? { displayName: session.displayName } : {}),
          ...(session?.boardFace ? { boardFace: session.boardFace } : {}),
        };
      };
      return resolved.ok
        ? { ok: true, ...present(resolved) }
        : {
            ok: false,
            ...(resolved.candidates ? { candidates: resolved.candidates.map(present) } : {}),
          };
    }
    throw new Error(`Unexpected gateway request: ${method}`);
  });
  (context.gateway.snapshot.client as unknown as { request: typeof request }).request = request;
  return request;
}

// The router navigates with `options`, not the shareable `href`, so route-loader
// coverage has to start from the same location the app actually pushes.
export function sessionRouteLocation(target: ReturnType<typeof sessionNavigationTarget>) {
  return { pathname: target.options.pathname, search: target.options.search ?? "", hash: "" };
}
