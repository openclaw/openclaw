// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { resolveCatalogContinuation } from "./route-loader-catalog-share.runtime.ts";
import { loadCatalogShareRouteFromLocation } from "./route-loader-catalog-share.ts";
import { loadRoute, routeLocation } from "./route-loading.test-support.ts";

const fullId = "0123456789abcdef0123456789abcdef";
const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "beam",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const;

function catalogContext(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  basePath = "",
): ApplicationContext {
  return {
    basePath,
    gateway: {
      snapshot: { phase: "connected", client: { request }, hello: null },
      subscribe: vi.fn(() => () => undefined),
    },
    agents: { state: { agentsList: { defaultId: "research", mainKey: "main" } } },
    agentSelection: { state: { selectedId: "research" } },
    sessions: { state: { result: null } },
  } as unknown as ApplicationContext;
}

function beamCatalog(
  sessions: Array<{ threadId: string; name: string; sessionKey?: string }>,
  nextCursor?: string,
) {
  return {
    catalogs: [
      {
        id: "beam",
        label: "Beam",
        shareRoute: SHARE_ROUTE,
        hosts: [
          {
            hostId: "gateway",
            sessions,
            ...(nextCursor ? { nextCursor } : {}),
          },
        ],
      },
    ] satisfies [object],
  };
}
const loadCatalog = (result: unknown, path = "/beam/0123456789ab") =>
  loadRoute(catalogContext(vi.fn(async () => result)), path);

describe("catalog share route resolution", () => {
  it("does not request a catalog after cancellation during deferred resolver loading", async () => {
    const request = vi.fn(async () => beamCatalog([{ threadId: fullId, name: "Canceled Beam" }]));
    const abort = new AbortController();
    const pending = loadCatalogShareRouteFromLocation(
      catalogContext(request),
      routeLocation("/beam/0123456789ab"),
      abort.signal,
    );
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });
  it("resolves a Visitor owned Beam link without requesting the operator catalog", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "beam.owned.list") {
        throw new Error("missing scope: operator.read");
      }
      return beamCatalog([{ threadId: fullId, name: "Owned synthetic Beam" }]);
    });
    const context = catalogContext(request);
    context.gateway.snapshot.hello = gatewayHelloForMethods(
      ["beam.owned.list", "beam.owned.read"],
      ["operator.sessions.write"],
    );
    await expect(loadRoute(context, "/beam/0123456789ab")).resolves.toMatchObject({
      kind: "session",
      sessionKey: `agent:research:catalog:beam:gateway:${fullId}`,
    });
  });
  it("resolves an external-style provider descriptor without catalog-specific UI policy", async () => {
    const result = beamCatalog([{ threadId: fullId, name: "External session" }]);
    const catalog = {
      ...result.catalogs[0],
      id: "external",
      label: "External",
      shareRoute: { ...SHARE_ROUTE, routeSegment: "shared-sessions" },
    };
    await expect(
      loadCatalog({ catalogs: [catalog] }, "/shared-sessions/0123456789ab"),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: `agent:research:catalog:external:gateway:${fullId}`,
    });
  });

  it.each(["0123456789ab", "old-title-0123456789ab", "pretty-beam-route-0123456789ab"])(
    "resolves %s by id and canonicalizes the title under the default agent",
    async (reference) => {
      const request = vi.fn(async (method: string) => {
        if (method !== "sessions.catalog.list") {
          throw new Error(`Unexpected gateway request: ${method}`);
        }
        return beamCatalog([{ threadId: fullId, name: "Pretty Beam route" }]);
      });

      const loaded = await loadRoute(
        catalogContext(request, "/openclaw"),
        `/openclaw/beam/${reference}`,
      );

      expect(loaded).toMatchObject({
        kind: "session",
        sessionKey: `agent:research:catalog:beam:gateway:${fullId}`,
        agentId: "research",
        face: "chat",
      });
      if (reference === "pretty-beam-route-0123456789ab") {
        expect(loaded).not.toHaveProperty("canonicalLocation");
      } else {
        expect(loaded).toMatchObject({
          canonicalLocation: routeLocation("/openclaw/beam/pretty-beam-route-0123456789ab"),
          canonicalLocationSource: routeLocation(`/openclaw/beam/${reference}`),
        });
      }
      expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
        agentId: "research",
        search: "0123456789ab",
        limitPerHost: 2,
      });
    },
  );

  it("keeps ambiguity, invalid ids, and disabled route owners visible", async () => {
    const ids = ["0123456789ab00000000000000000000", "0123456789abffffffffffffffffffff"];
    const ambiguous = beamCatalog(
      ids.map((threadId) => ({ threadId, name: "Candidate" })),
      "more",
    );

    await expect(loadCatalog(ambiguous, "/beam/candidate-0123456789ab")).resolves.toMatchObject({
      kind: "ambiguous",
      shortId: "0123456789ab",
      candidates: [{ href: `/beam/candidate-${ids[0]}` }, { href: `/beam/candidate-${ids[1]}` }],
      truncated: true,
    });

    await expect(loadCatalog(beamCatalog([]), "/beam/aaaaaaaaaaaa")).resolves.toMatchObject({
      kind: "missing-session",
      currentSessionHref: "/chat/research",
      sessionsHref: "/sessions",
    });

    await expect(loadCatalog(ambiguous, "/beam/ABCDEF012345")).resolves.toMatchObject({
      kind: "route-error",
      message: "This Beam share URL is invalid.",
    });

    await expect(loadCatalog({ catalogs: [] })).resolves.toMatchObject({
      kind: "route-error",
      message: "This shared session route is unavailable.",
    });

    const { catalogs } = beamCatalog([{ threadId: fullId, name: "First" }]);
    await expect(
      loadCatalog({ catalogs: [...catalogs, { ...catalogs[0], id: "other" }] }),
    ).resolves.toMatchObject({
      kind: "route-error",
    });
  });

  it("keeps paginated empty results ambiguous and rejects duplicate declared hosts", async () => {
    await expect(loadCatalog(beamCatalog([], "more"))).resolves.toMatchObject({
      kind: "ambiguous",
      candidates: [],
      truncated: true,
    });

    const catalog = beamCatalog([{ threadId: fullId, name: "First" }]).catalogs[0];
    const duplicateHost = { ...catalog, hosts: [...catalog.hosts, { ...catalog.hosts[0] }] };
    await expect(loadCatalog({ catalogs: [duplicateHost] })).resolves.toMatchObject({
      kind: "route-error",
    });
  });

  it("preserves full-id links while canonicalizing an internally bridged stale name", async () => {
    const request = vi.fn(async () => beamCatalog([{ threadId: fullId, name: "Renamed session" }]));
    const originalPath = `/openclaw/beam/old-name-${fullId}`;
    const loaded = await loadRoute(
      catalogContext(request, "/openclaw"),
      "/openclaw/chat",
      `?${new URLSearchParams({ [INTERNAL_SESSION_PATH_PARAM]: originalPath })}`,
    );
    expect(loaded).toMatchObject({
      kind: "session",
      sessionKey: `agent:research:catalog:beam:gateway:${fullId}`,
      canonicalLocation: routeLocation(`/openclaw/beam/renamed-session-${fullId}`),
      canonicalLocationSource: routeLocation(originalPath),
    });
    expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
      agentId: "research",
      search: fullId,
      limitPerHost: 2,
    });
  });
});

it("reopens a Beam at its one live destination, retaining the bound non-default agent", async () => {
  const key = "agent:analysis:dashboard:handoff";
  const request = vi.fn(async (method: string) =>
    method.endsWith(".resolve")
      ? { sessionKey: key }
      : beamCatalog([{ threadId: fullId, name: "Continued investigation", sessionKey: key }]),
  );
  const context = catalogContext(request);
  for (let reopen = 0; reopen < 2; reopen++) {
    await expect(loadRoute(context, "/beam/0123456789ab")).resolves.toMatchObject({
      kind: "session",
      sessionKey: key,
      agentId: "analysis",
    });
  }
  expect(request.mock.calls.some(([method]) => method.endsWith(".continue"))).toBe(false);
});

it.each([
  ["share", "list", "hello"],
  ["share", "resolve", "hello"],
  ["query", "resolve", "hello"],
  ["query", "resolve", "client"],
] as const)("rejects stale %s %s results after %s replacement", async (route, phase, changed) => {
  const entered = createDeferredCore();
  const deferred = createDeferredCore<unknown>();
  const key = "agent:analysis:dashboard:handoff";
  const listed = beamCatalog([
    { threadId: fullId, name: "Continued investigation", sessionKey: key },
  ]);
  const request = vi.fn(async (method: string) => {
    if (method.endsWith(`.${phase}`)) {
      entered.resolve();
      return deferred.promise;
    }
    return method.endsWith(".resolve") ? { sessionKey: key } : listed;
  });
  const context = catalogContext(request);
  const loading =
    route === "share"
      ? loadRoute(context, "/beam/0123456789ab")
      : resolveCatalogContinuation(
          context,
          { catalogId: "beam", hostId: "gateway", threadId: fullId },
          "research",
          new AbortController().signal,
        );
  await entered.promise;
  Object.assign(
    context.gateway.snapshot,
    changed === "hello"
      ? {
          hello: gatewayHelloForMethods(
            ["sessions.catalog.list", "sessions.catalog.resolve"],
            ["operator.read"],
          ),
        }
      : { client: { request } },
  );
  const checked =
    route === "share"
      ? expect(loading).resolves.toMatchObject({
          kind: "route-error",
          message: expect.stringContaining("connection changed"),
        })
      : expect(loading).rejects.toThrow("connection changed");
  deferred.resolve(phase === "list" ? listed : { sessionKey: key });
  await checked;
  expect(request.mock.calls.some(([method]) => method.endsWith(".continue"))).toBe(false);
});

it.each([null, { sessionKey: "agent:analysis:dashboard:handoff" }])(
  "resolves a query link directly under Gateway policy: %j",
  async (result) => {
    const request = vi.fn(async () => result);
    await expect(
      resolveCatalogContinuation(
        catalogContext(request),
        { catalogId: "beam", hostId: "gateway", threadId: fullId },
        "research",
        new AbortController().signal,
      ),
    ).resolves.toEqual(result ? { ...result, agentId: "analysis" } : undefined);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.catalog.resolve",
      { catalogId: "beam", hostId: "gateway", threadId: fullId, agentId: "research" },
      { signal: expect.any(AbortSignal) },
    );
  },
);

it("preserves a query resolution denial without falling back to discovery", async () => {
  const denied = new Error("session catalog thread is not visible to this caller");
  const request = vi.fn(async () => {
    throw denied;
  });
  await expect(
    resolveCatalogContinuation(
      catalogContext(request),
      { catalogId: "beam", hostId: "gateway", threadId: fullId },
      "research",
      new AbortController().signal,
    ),
  ).rejects.toBe(denied);
  expect(request).toHaveBeenCalledTimes(1);
});
