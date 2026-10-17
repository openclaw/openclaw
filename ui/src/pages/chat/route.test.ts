// @vitest-environment node
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createApplicationRouter } from "../../app-routes.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createChatPageSessions } from "./chat-page-sessions.test-support.ts";
import { loadChatRoute } from "./route-loader.ts";
import { loadRoute, routeLocation as locationFor } from "./route-loading.test-support.ts";
import { pages } from "./route.ts";
import type { SessionChatRouteData } from "./session-route-data.ts";

const keyUuid = "12345678-90ab-cdef-1234-567890abcdef";
const sessionKey = `agent:main:dashboard:${keyUuid}`;
const replacementKey = "agent:main:dashboard:12345678-0000-4000-8000-000000000001";
const sessionData = (key: string | undefined, fields: Partial<SessionChatRouteData> = {}) => ({
  kind: "session",
  sessionKey: key,
  draft: undefined,
  face: "chat",
  ...fields,
});

function row(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: sessionKey,
    kind: "direct",
    updatedAt: 1,
    displayName: "Deploy Monitor",
    sessionId: "fedcba98-7654-3210-fedc-ba9876543210",
    ...overrides,
  };
}
const resolvedRow = (key = sessionKey): SessionsResolveResult => ({
  ok: true,
  ...row({ key }),
  agentId: "main",
});

function contextFor(resolution: SessionsResolveResult = { ok: false }, mainKey = "main") {
  const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "sessions.resolve") {
      return resolution;
    }
    throw new Error(`Unexpected gateway request: ${method}`);
  });
  const client = { request };
  const context = {
    basePath: "",
    chatSubmissions: createChatSubmissions(),
    placementStartup: { get: vi.fn(() => null) },
    router: { getState: () => ({ matches: [], pendingMatches: [] }), subscribe: () => () => {} },
    gateway: {
      snapshot: { phase: "connected", client, hello: null },
      subscribe: vi.fn(() => () => undefined),
      subscribeEvents: vi.fn(() => () => undefined),
    },
    agents: { state: { agentsList: { mainKey } } },
  } as unknown as ApplicationContext;
  const sessions = createChatPageSessions(context.gateway);
  const list = vi.spyOn(sessions, "list");
  return { context: { ...context, sessions }, list, request };
}

function coldContext() {
  type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
  let listener: GatewayListener | null = null;
  const gateway = {
    snapshot: {
      phase: "connecting",
      client: null,
      hello: null,
    } as ApplicationContext["gateway"]["snapshot"],
    subscribe: (next: GatewayListener) => {
      listener = next;
      return () => undefined;
    },
  };
  const context = {
    basePath: "",
    gateway,
    agents: { state: { agentsList: null } },
    sessions: createChatPageSessions(),
  } as unknown as ApplicationContext;
  return {
    context,
    connect(this: void, mainKey = "workspace") {
      gateway.snapshot = {
        phase: "connected",
        client: {},
        hello: { snapshot: { sessionDefaults: { mainKey } } },
      } as unknown as ApplicationContext["gateway"]["snapshot"];
      if (!listener) {
        throw new Error("expected gateway readiness subscription");
      }
      listener(gateway.snapshot);
    },
  };
}

async function mountedSession(reference: string, user?: string) {
  const fixture = contextFor(resolvedRow());
  if (user) {
    fixture.context.gateway.snapshot.selfUser = { id: user };
  }
  const router = createApplicationRouter();
  onTestFinished(() => router.stop());
  const route = router.getRoute("chat")!;
  const component = vi.spyOn(route, "component").mockResolvedValue({ renderSolid: () => null });
  onTestFinished(() => component.mockRestore());
  const scopedContext = { ...fixture.context, router };
  const location = locationFor(`/chat/main/${reference}`);
  await router.navigate("chat", scopedContext, {}, location);
  return { ...fixture, router, route, scopedContext, location };
}

describe("loadChatRoute", () => {
  it.each(["connection", "profile"])(
    "does not carry an established key into a new %s scope",
    async (replacement) => {
      const { context, request, route, scopedContext, location } = await mountedSession(
        "deploy-monitor-12345678",
        "first",
      );
      if (replacement === "connection") {
        Object.defineProperty(context.gateway, "connectionRevision", { value: 1 });
      } else {
        context.gateway.snapshot.selfUser = { id: "second" };
      }
      request.mockImplementation(async (_method, params) =>
        params.shortId ? resolvedRow(replacementKey) : { ok: false },
      );
      const loaded = await route.loader!(scopedContext, {
        location,
        deps: route.loaderDeps!(scopedContext, location),
        cause: "revalidate",
        revalidating: true,
        shouldRun: () => true,
        signal: new AbortController().signal,
      });
      expect(loaded).toMatchObject(sessionData(replacementKey));
    },
  );

  it.each(["deploy-monitor-12345678", "deploy-monitor"])(
    "keeps a disconnected exact revalidation retryable for %s",
    async (reference) => {
      const { context, request, router, scopedContext } = await mountedSession(reference);
      const pending = createDeferredCore<SessionsResolveResult>();
      request.mockReturnValueOnce(pending.promise);
      const revalidation = router
        .revalidate(scopedContext, "chat")
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      context.gateway.snapshot.phase = "reconnecting";
      pending.resolve({ ok: false });
      await revalidation;
      expect(router.getState().matches[0]?.status).toBe("error");
      context.gateway.snapshot.phase = "connected";
      request.mockResolvedValue({ ok: false });
      await router.revalidate(scopedContext, "chat");
      expect(router.getState().matches[0]?.data).toMatchObject({ kind: "missing-session" });
    },
  );

  it.each(["deploy-monitor-12345678", "deploy-monitor"])(
    "keeps revalidation bound to the established session when %s is reassigned",
    async (reference) => {
      const { request, router, scopedContext } = await mountedSession(reference);
      expect(router.getState().matches[0]?.data).toMatchObject({ sessionKey });
      request.mockImplementation(async (_method, params) =>
        params.reference &&
        typeof params.reference === "object" &&
        "key" in params.reference &&
        params.reference.key === sessionKey
          ? { ok: false }
          : resolvedRow(replacementKey),
      );
      await router.revalidate(scopedContext, "chat");
      expect(router.getState().matches[0]?.data).toMatchObject({ kind: "missing-session" });
      expect(request).toHaveBeenLastCalledWith(
        "sessions.resolve",
        expect.objectContaining({ reference: { key: sessionKey } }),
      );
    },
  );

  it("revalidates an exact slug-shaped key instead of trusting a retained roster row", async () => {
    const { context, request } = contextFor();
    const key = "agent:main:research";
    context.sessions.state.result = sessionsResult([row({ key })], 1);
    const location = locationFor("/chat/main/research");
    await expect(loadRoute(context, location)).resolves.toMatchObject(sessionData(key));
    expect(request).not.toHaveBeenCalled();
    await expect(
      loadChatRoute(context, location, "chat", new AbortController().signal, {}),
    ).resolves.toMatchObject({ kind: "missing-session" });
    expect(request).toHaveBeenCalledOnce();
  });
  it("leaves a bare namespace unresolved instead of inventing a main session", async () => {
    const { context, list } = contextFor({ ok: false }, "workspace");
    const loaded = await loadRoute(context, "/chat");

    expect(loaded).toEqual({ type: "notFound", data: { routeId: "chat" } });
    expect(list).not.toHaveBeenCalled();
  });

  it("builds distinct working links for ambiguous prefixes", async () => {
    const rows = [
      row({ key: "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001" }),
      row({
        key: "agent:work:dashboard:12345678-0bbb-4000-8000-000000000002",
        displayName: "Deploy Monitor Two",
      }),
    ];
    const { context, request } = contextFor({
      ok: false,
      candidates: rows.map(({ key, displayName }) => ({
        key,
        agentId: key.split(":")[1]!,
        displayName: displayName ?? undefined,
      })),
    });
    const ambiguous = await loadRoute(
      context,
      "/dashboard/ignored/deploy-12345678",
      "?draft=ship&__openclawComposerFocus=1",
      "dashboard",
    );
    expect(ambiguous).toMatchObject({ kind: "ambiguous", truncated: false });
    if (!("kind" in ambiguous) || ambiguous.kind !== "ambiguous") {
      throw new Error("expected an ambiguous route");
    }
    expect(ambiguous.candidates.map((candidate) => candidate.href)).toEqual([
      "/dashboard/main/deploy-monitor-123456780a?draft=ship&__openclawComposerFocus=1",
      "/dashboard/work/deploy-monitor-two-123456780b?draft=ship&__openclawComposerFocus=1",
    ]);

    for (const [candidate, expectedRow] of ambiguous.candidates.map(
      (entry, index) => [entry, rows[index]] as const,
    )) {
      request.mockResolvedValueOnce({ ok: true, ...expectedRow!, agentId: candidate.agentId });
      const url = new URL(candidate.href, "https://control.test");
      await expect(loadRoute(context, url.pathname, url.search, "dashboard")).resolves.toEqual(
        sessionData(expectedRow?.key, {
          routeLoadingSkeleton: true,
          agentId: candidate.agentId,
          draft: "ship",
          focusComposer: true,
          face: "dashboard",
          shortId: candidate.idPrefix,
        }),
      );
    }
  });

  it.each(["dashboard", "chat"] as const)(
    "carries expanded dashboard presentation into %s route data",
    async (face) => {
      const { context } = contextFor();
      await expect(
        loadRoute(context, `/${face}/work`, "?dashboard=expanded", face),
      ).resolves.toMatchObject(
        sessionData("agent:work:main", {
          face,
          dashboardExpanded: true,
        }),
      );
    },
  );

  it("reclassifies a slug-shaped path after cold defaults reveal the main key", async () => {
    const { context, connect } = coldContext();
    const pending = loadRoute(context, "/chat/research/workspace");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    connect();

    await expect(pending).resolves.toEqual(
      sessionData("agent:research:workspace", {
        canonicalLocation: locationFor("/chat/research"),
        canonicalLocationSource: locationFor("/chat/research/workspace"),
      }),
    );
  });

  it.each([
    ["team/primary", "team:primary", locationFor("/chat/research")],
    ["main", "workspace", null],
  ] as const)(
    "canonicalizes literal %s after cold defaults arrive",
    async (path, mainKey, expected) => {
      const { context, connect } = coldContext();
      const loaded = await loadRoute(context, `/chat/research/${path}`);
      expect(loaded).toMatchObject(sessionData(`agent:research:${path.replaceAll("/", ":")}`));
      if (!("kind" in loaded) || loaded.kind !== "session" || !loaded.canonicalLocationReady) {
        throw new Error("expected deferred main-session canonicalization");
      }

      connect(mainKey);

      await expect(loaded.canonicalLocationReady).resolves.toEqual(expected);
    },
  );

  it("loads a specific synthetic catalog thread from its URL target", async () => {
    const { context, list } = contextFor();
    await expect(
      loadRoute(context, "/chat/main", "?catalog=claude&host=gateway%3Alocal&thread=thread-2"),
    ).resolves.toEqual(
      sessionData("agent:main:catalog:claude:gateway%3Alocal:thread-2", {
        agentId: "main",
      }),
    );
    expect(list).not.toHaveBeenCalled();
  });
  it.each([pages[1]])("isolates $id loader results across connection owners", (page) => {
    const { context } = contextFor();
    let snapshot = context.gateway.snapshot;
    let revision = 0;
    const gateway = {
      ...context.gateway,
      get snapshot() {
        return snapshot;
      },
      get connectionRevision() {
        return revision;
      },
    };
    const scopedContext = { ...context, gateway };
    const location = locationFor(`/${page.id}/main`);
    const cacheKey = () => page.loaderDeps!(scopedContext, location);
    const initial = cacheKey();

    snapshot = { ...snapshot, selfUser: { id: "first-user" } };
    expect(cacheKey()).toBe(initial);
    snapshot = { ...snapshot, phase: "reconnecting", selfUser: null };
    expect(cacheKey()).toBe(initial);
    snapshot = { ...snapshot, phase: "connected", selfUser: { id: "first-user" } };
    expect(cacheKey()).toBe(initial);

    snapshot = { ...snapshot, selfUser: { id: "second-user" } };
    const replacementUser = cacheKey();
    expect(replacementUser).not.toBe(initial);
    revision += 1;
    const replacementCredentials = cacheKey();
    expect(replacementCredentials).not.toBe(replacementUser);
    expect(page.loaderDeps!({ ...scopedContext, gateway: { ...gateway } }, location)).not.toBe(
      replacementCredentials,
    );
  });
});
