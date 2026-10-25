// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createApplicationRouter } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { loadChatRoute } from "./route-loader.ts";
import { loadRoute, routeLocation as locationFor } from "./route-loading.test-support.ts";
import {
  createSessionRouteContext,
  createSessionRouteRow,
} from "./route-resolution.test-support.ts";
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
  return createSessionRouteRow({ key: sessionKey, displayName: "Deploy Monitor", ...overrides });
}
const resolvedRow = (key = sessionKey): SessionsResolveResult => ({
  ok: true,
  ...row({ key }),
  agentId: "main",
});

function contextFor(resolution: SessionsResolveResult = { ok: false }, mainKey = "main") {
  return createSessionRouteContext(resolution, [], { agentId: "main", mainKey });
}

function coldContext() {
  const { context, publishGateway } = contextFor();
  publishGateway({ phase: "connecting", client: null, hello: null });
  context.agents.state.agentsList = null;
  return {
    context,
    connect(this: void, mainKey = "workspace") {
      publishGateway({
        phase: "connected",
        client: {},
        hello: { snapshot: { sessionDefaults: { mainKey } } },
      } as unknown as ApplicationContext["gateway"]["snapshot"]);
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
      request.mockImplementation(async (_method, params) => {
        if (!isRecord(params)) {
          throw new Error("Missing resolution parameters");
        }
        return params.shortId ? resolvedRow(replacementKey) : { ok: false };
      });
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
    "keeps %s bound to its established key through disconnected revalidation",
    async (reference) => {
      const { context, request, router, scopedContext } = await mountedSession(reference);
      const pending = createDeferredCore<SessionsResolveResult>();
      request.mockImplementation(async (_method, params) => {
        if (!isRecord(params)) {
          throw new Error("Missing resolution parameters");
        }
        return isRecord(params.reference) && params.reference.key === sessionKey
          ? pending.promise
          : resolvedRow(replacementKey);
      });
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

  it("builds working dashboard links for ambiguous prefixes", async () => {
    const rows = ["0aaa-4000-8000-000000000001", "0bbb-4000-8000-000000000002"].map(
      (suffix, index) =>
        row({
          key: `agent:${index ? "work" : "main"}:dashboard:12345678-${suffix}`,
          displayName: index ? "Deploy Monitor Two" : "Deploy Monitor",
        }),
    );
    const { context, request, list } = contextFor({
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
    expect(ambiguous).toMatchObject({
      kind: "ambiguous",
      truncated: false,
    });
    if (!("kind" in ambiguous) || ambiguous.kind !== "ambiguous") {
      throw new Error("expected ambiguous route");
    }
    expect(ambiguous.candidates.map((candidate) => candidate.href)).toEqual([
      "/dashboard/main/deploy-monitor-123456780a?draft=ship&__openclawComposerFocus=1",
      "/dashboard/work/deploy-monitor-two-123456780b?draft=ship&__openclawComposerFocus=1",
    ]);
    expect(list).not.toHaveBeenCalled();
    for (const [index, candidate] of ambiguous.candidates.entries()) {
      const expectedRow = rows[index]!;
      request.mockResolvedValueOnce({ ok: true, ...expectedRow, agentId: candidate.agentId });
      const url = new URL(candidate.href, "https://control.test");
      await expect(loadRoute(context, url.pathname, url.search, "dashboard")).resolves.toEqual(
        sessionData(expectedRow.key, {
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

  it("reclassifies a slug-shaped path after cold defaults reveal the main key", async () => {
    const { context, connect } = coldContext();
    const pending = loadRoute(context, "/chat/research/workspace");
    const settled = vi.fn();
    void pending.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

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
    const gateway = { ...context.gateway, connectionRevision: 0 };
    const scopedContext = { ...context, gateway };
    const location = locationFor(`/${page.id}/main`);
    const cacheKey = () => page.loaderDeps!(scopedContext, location);
    const initial = cacheKey();

    gateway.snapshot = { ...gateway.snapshot, selfUser: { id: "first-user" } };
    expect(cacheKey()).toBe(initial);
    gateway.snapshot = { ...gateway.snapshot, phase: "reconnecting", selfUser: null };
    expect(cacheKey()).toBe(initial);
    gateway.snapshot = { ...gateway.snapshot, phase: "connected", selfUser: { id: "first-user" } };
    expect(cacheKey()).toBe(initial);

    gateway.snapshot = { ...gateway.snapshot, selfUser: { id: "second-user" } };
    const replacementUser = cacheKey();
    expect(replacementUser).not.toBe(initial);
    gateway.connectionRevision += 1;
    const replacementCredentials = cacheKey();
    expect(replacementCredentials).not.toBe(replacementUser);
    expect(page.loaderDeps!({ ...scopedContext, gateway: { ...gateway } }, location)).not.toBe(
      replacementCredentials,
    );
  });
});
