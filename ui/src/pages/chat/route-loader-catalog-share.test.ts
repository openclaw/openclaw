// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
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

function beamCatalog(sessions: Array<{ threadId: string; name: string }>, nextCursor?: string) {
  return {
    catalogs: [
      {
        id: "beam",
        label: "Beam",
        capabilities: { continueSession: false, archive: false },
        shareRoute: SHARE_ROUTE,
        hosts: [
          {
            hostId: "gateway",
            label: "Beamed sessions",
            kind: "gateway",
            connected: true,
            sessions: sessions.map((session) => ({
              ...session,
              status: "live",
              archived: false,
              canContinue: false,
              canArchive: false,
            })),
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
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      beamCatalog(
        params.search === "0123456789ab"
          ? ids.map((threadId, index) => ({
              threadId,
              name: `Candidate ${String(index + 1)}`,
            }))
          : [],
        params.search === "0123456789ab" ? "more" : undefined,
      ),
    );
    const context = catalogContext(request);

    await expect(loadRoute(context, "/beam/candidate-0123456789ab")).resolves.toMatchObject({
      kind: "ambiguous",
      shortId: "0123456789ab",
      candidates: [{ href: `/beam/candidate-${ids[0]}` }, { href: `/beam/candidate-${ids[1]}` }],
      truncated: true,
    });

    await expect(loadRoute(context, "/beam/aaaaaaaaaaaa")).resolves.toMatchObject({
      kind: "missing-session",
      currentSessionHref: "/chat/research",
      sessionsHref: "/sessions",
    });

    await expect(loadRoute(context, "/beam/ABCDEF012345")).resolves.toMatchObject({
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
