// @vitest-environment node
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { prepareSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import {
  resolveSessionPreferredFaceForKey,
  SESSION_COMPOSER_FOCUS_PARAM,
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { createControlUiSessionFixtures } from "../../test-helpers/control-ui-session-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { locationWithoutDraft } from "./route-draft.ts";
import { loadChatRoute } from "./route-loader.ts";
import { loadRoute, routeLocation as locationFor } from "./route-loading.test-support.ts";
import {
  canonicalSession,
  createSessionRouteContext as contextFor,
  createSessionRouteRow as row,
  installShortSessionResolver as installShortResolver,
  loadSessionRoute as load,
  sessionRouteLocation as targetLocation,
  sessionRouteKey as resolvedKey,
  sessionRouteUuid as uuid,
} from "./route-resolution.test-support.ts";

const dashboardPath =
  "/dashboard/roboclaw/default-mode-with-rare-surprises-1234567890abcdef1234567890abcdef";
const literalRow = (id = uuid, prefix = "") =>
  row({ key: `agent:main:${prefix}${id}`, sessionId: id, displayName: undefined });
function dashboardTarget() {
  const dashboardRow = row({ boardFace: "dashboard" });
  const { context } = contextFor();
  installShortResolver(context, [dashboardRow]);
  const face = resolveSessionPreferredFaceForKey(context, dashboardRow.key);
  const target = sessionNavigationTarget({
    context,
    face,
    sessionKey: dashboardRow.key,
    preferenceDerivedFace: true,
  });
  return { context, dashboardRow, face, target };
}
function pendingContext() {
  const fixture = contextFor();
  const pending = createDeferred<SessionsResolveResult>();
  fixture.request.mockImplementation(() => pending.promise);
  return { ...fixture, pending };
}
describe("gateway-backed session route resolution", () => {
  it("resolves a non-default agent's canonical global face from its scoped row", async () => {
    const globalRow = row({ key: "global", kind: "global", boardFace: "dashboard" });
    const { context, list, request } = contextFor({ ok: true, ...globalRow, agentId: "research" });
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [],
    };
    context.gateway.snapshot.hello = {
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "main",
          mainKey: "main",
          mainSessionKey: "global",
        },
      },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await expect(
      loadRoute(context, "/chat/research", `?${SESSION_FACE_PREFERENCE_PARAM}=1`),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: "global",
      agentId: "research",
      draft: undefined,
      face: "dashboard",
      canonicalLocation: locationFor("/dashboard/research"),
      canonicalLocationSource: locationFor("/chat/research", `?${SESSION_FACE_PREFERENCE_PARAM}=1`),
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.resolve", {
      reference: { key: "agent:research:main" },
      agentId: "research",
      includeGlobal: true,
      includeUnknown: true,
      allowMissing: true,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "applies a stored face to a preference open (normalized: %s)",
    async (normalized) => {
      const { context, dashboardRow, face, target } = dashboardTarget();
      expect(face).toBe("chat");
      expect(target.options.pathname).toBe("/chat/roboclaw/1234567890abcdef1234567890abcdef");
      const location = targetLocation(target);
      if (normalized) {
        const search = new URLSearchParams(location.search);
        search.set(INTERNAL_SESSION_PATH_PARAM, location.pathname);
        Object.assign(location, locationFor("/chat", `?${search.toString()}`));
      }
      await expect(loadRoute(context, location, "", face)).resolves.toMatchObject({
        kind: "session",
        sessionKey: dashboardRow.key,
        face: "dashboard",
        canonicalLocation: { pathname: dashboardPath, search: "" },
      });
    },
  );

  it("applies an uncached stored face to a preference-derived catalog open", async () => {
    const catalogKey = buildCatalogSessionKey({
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    const catalogRow = row({ key: catalogKey, boardFace: "dashboard" });
    const { context } = contextFor({ ok: true, ...catalogRow, agentId: "roboclaw" });
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: catalogKey,
      fallbackAgentId: "roboclaw",
      preferenceDerivedFace: true,
    });

    await expect(loadRoute(context, targetLocation(target))).resolves.toEqual({
      kind: "session",
      sessionKey: `agent:roboclaw:${catalogKey}`,
      agentId: "roboclaw",
      draft: undefined,
      face: "dashboard",
      canonicalLocation: locationFor(
        "/dashboard/roboclaw",
        "?catalog=claude&host=gateway%3Alocal&thread=thread-1",
      ),
      canonicalLocationSource: targetLocation(target),
    });
  });

  it("returns slug ties to the existing disambiguation view", async () => {
    const rows = [
      row({ key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001" }),
      row({ key: "agent:research:thread:12345678-0bbb-4000-8000-000000000002" }),
    ];
    const { context, list, request } = contextFor({
      ok: false,
      candidates: rows.map(({ key, displayName }) => ({
        key,
        agentId: key.split(":")[1]!,
        displayName: displayName ?? undefined,
      })),
    });
    const loaded = await loadRoute(context, "/chat/roboclaw/default-mode-with-rare-surprises");

    expect(loaded).toMatchObject({
      kind: "ambiguous",
      shortId: "default-mode-with-rare-surprises",
      truncated: false,
      candidates: [{ agentId: "roboclaw" }, { agentId: "research" }],
    });
    if (!("kind" in loaded) || loaded.kind !== "ambiguous") {
      throw new Error("expected slug disambiguation");
    }
    expect(loaded.candidates.map((candidate) => candidate.href)).toEqual([
      "/chat/roboclaw/default-mode-with-rare-surprises-123456780a",
      "/chat/research/default-mode-with-rare-surprises-123456780b",
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    [
      "deploy-monitor-12345678",
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "invalid sessions.resolve params: at root: unexpected property 'shortId'",
      }),
    ],
    ["existing-literal", new Error("lookup unavailable")],
  ] as const)("surfaces current authoritative lookup errors for %s", async (reference, error) => {
    const { context, list, request } = contextFor(error);
    await expect(loadRoute(context, `/chat/roboclaw/${reference}`)).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["short", "reference"] as const)(
    "rejects a %s result after navigation ownership is aborted",
    async (kind) => {
      const { context, list, request, pending } = pendingContext();
      const controller = new AbortController();
      const pathname =
        kind === "short"
          ? "/chat/roboclaw/deploy-monitor-12345678"
          : "/dashboard/roboclaw/deploy-monitor";
      const navigation = loadChatRoute(
        context,
        locationFor(pathname),
        kind === "short" ? "chat" : "dashboard",
        controller.signal,
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const reason = new Error("navigation superseded");
      controller.abort(reason);
      pending.resolve({ ok: true, key: resolvedKey, agentId: "roboclaw" });

      await expect(navigation).rejects.toBe(reason);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("treats a full ten-candidate response as conservatively truncated", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      row({
        key: `agent:roboclaw:thread:12345678-${index.toString(16).padStart(4, "0")}-4000-8000-000000000000`,
        displayName: `Candidate ${index}`,
      }),
    );
    const { context } = contextFor();
    installShortResolver(context, rows, {
      ok: false,
      candidates: rows.map(({ key }) => ({ key })),
    });
    const loaded = await loadRoute(context, "/chat/roboclaw/12345678");

    expect(loaded).toMatchObject({ kind: "ambiguous", shortId: "12345678", truncated: true });
  });

  it("opens a mechanically composed single-segment UUID as its exact session key", async () => {
    const literalKey = `agent:main:${uuid}`;
    const literal = row({ key: literalKey, displayName: undefined });
    const { context, list } = contextFor();
    const request = installShortResolver(context, [], { ok: false });
    request.mockResolvedValueOnce({ ok: false });
    request.mockResolvedValueOnce({ ok: true, ...literal, agentId: "main" });

    const loaded = await loadRoute(context, `/chat/main/${uuid}`);

    expect(loaded).toMatchObject({
      kind: "session",
      sessionKey: literalKey,
      canonicalLocation: { pathname: "/chat/main/1234567890abcdef1234567890abcdef" },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("sessions.resolve", {
      reference: { key: literalKey },
      agentId: "main",
      includeGlobal: true,
      includeUnknown: true,
      allowMissing: true,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("uses forced-literal URLs to avoid a colliding short session reference", async () => {
    const collidingUuid = "567890ab-cdef-4321-8765-43210fedcba9";
    const literal = literalRow();
    const shortMatch = literalRow(collidingUuid, "thread:");
    const { context } = contextFor();
    const request = installShortResolver(context, [literal, shortMatch], {
      ok: true,
      key: shortMatch.key,
    });
    request.mockResolvedValueOnce({ ok: true, ...literal, agentId: "main" });
    const chipTarget = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey: literal.key,
      agentId: "main",
      preferenceDerivedFace: true,
      exactKey: true,
    });

    expect(chipTarget.options.pathname).toBe(`/chat/main/~key/${uuid}`);

    await expect(loadRoute(context, targetLocation(chipTarget))).resolves.toMatchObject({
      kind: "session",
      sessionKey: literal.key,
    });

    await expect(loadRoute(context, `/chat/main/${uuid}`)).resolves.toMatchObject({
      kind: "session",
      sessionKey: shortMatch.key,
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.resolve",
      expect.objectContaining({ shortId: "567890abcdef" }),
    );
  });

  it.each(["response", "error"] as const)(
    "ignores an obsolete connection's reference %s",
    async (outcome) => {
      const { context, list, request, pending } = pendingContext();
      const navigation = loadRoute(context, "/chat/roboclaw/existing-literal");
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      context.gateway.snapshot.client = {} as NonNullable<typeof context.gateway.snapshot.client>;
      if (outcome === "response") {
        pending.resolve({ ok: true, key: resolvedKey, agentId: "roboclaw" });
      } else {
        pending.reject(new Error("obsolete connection"));
      }
      await expect(navigation).resolves.toEqual({
        kind: "session",
        sessionKey: "agent:roboclaw:existing-literal",
        draft: undefined,
        face: "chat",
      });
      expect(list).not.toHaveBeenCalled();
    },
  );
});

const monitor = (suffix: string) =>
  row({
    key: `agent:roboclaw:thread:12345678-${suffix}`,
    displayName: "Deploy monitor",
  });

describe("session route navigation handoffs", () => {
  it.each([
    { hint: "composer focus", search: `?${SESSION_COMPOSER_FOCUS_PARAM}=1`, reconnect: false },
    { hint: "draft", search: "?draft=hello", reconnect: false },
    {
      hint: "composer focus across reconnect",
      search: `?${SESSION_COMPOSER_FOCUS_PARAM}=1`,
      reconnect: true,
    },
  ])(
    "carries a confirmed key through $hint cleanup only on its connection",
    async ({ search, reconnect }) => {
      const sessionKey = "agent:roboclaw:thread:0f403cb8-3920-4cf1-8eb7-79f2f00ce488";
      const pathname = "/chat/roboclaw/0f403cb839204cf18eb779f2f00ce488";
      const currentKey = sessionKey.replace(":thread:", ":dashboard:");
      const { context, request } = contextFor({ ok: true, key: currentKey, agentId: "roboclaw" });
      prepareSessionNavigationHandoff(context.gateway, pathname, sessionKey);
      const first = canonicalSession(
        await load(
          context,
          locationFor(
            pathname,
            `${search}&${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(sessionKey)}`,
          ),
        ),
      );
      expect(first.canonicalLocation.search).toBe(search);
      await expect(load(context, first.canonicalLocation)).resolves.toMatchObject({
        kind: "session",
        sessionKey,
      });
      expect(request).not.toHaveBeenCalled();
      if (reconnect) {
        context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.resolve"]);
      }
      const cleaned = await load(context, locationWithoutDraft(first.canonicalLocation));
      if (reconnect) {
        expect(cleaned).toMatchObject({ kind: "session", sessionKey: currentKey });
        expect(request).toHaveBeenCalledOnce();
      } else {
        expect(cleaned).toMatchObject({ kind: "session", sessionKey });
        expect(request).not.toHaveBeenCalled();
      }
    },
  );
  it("uses the sidebar-carried full key without issuing a session search", async () => {
    const storedRow = row({ displayName: "Deploy monitor" });
    const { context, list } = contextFor();
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: storedRow.key,
      fallbackAgentId: "roboclaw",
      row: storedRow,
    });
    prepareSessionNavigationHandoff(context.gateway, target.options.pathname, storedRow.key);
    const loaded = await load(context, locationFor(target.options.pathname));

    expect(loaded).toMatchObject({ kind: "session", sessionKey: storedRow.key });
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    { replaced: "client", pending: false },
    { replaced: "hello", pending: false },
    { replaced: "client", pending: true },
    { replaced: "hello", pending: true },
  ])(
    "rejects old resolution after $replaced replacement (in-flight: $pending)",
    async ({ replaced, pending }) => {
      const oldSession = monitor("0aaa-4000-8000-000000000001");
      const currentSession = monitor("0bbb-4000-8000-000000000002");
      const h = contextFor({
        ok: true,
        ...(pending ? currentSession : oldSession),
        agentId: "roboclaw",
      });
      const { context, list } = h;
      const snapshot = context.gateway.snapshot;
      const hello = () =>
        ({ snapshot: { sessionDefaults: { mainKey: "main" } } }) as NonNullable<
          ApplicationContext["gateway"]["snapshot"]["hello"]
        >;
      const deferred = createDeferred<SessionsResolveResult>();
      const face = pending ? "dashboard" : "chat";
      if (pending) {
        h.request.mockImplementationOnce(() => deferred.promise);
      } else {
        snapshot.hello = hello();
      }
      const navigation = load(
        context,
        locationFor(
          pending ? "/dashboard/roboclaw/old-name-12345678" : "/chat/roboclaw/deploy-monitor",
        ),
        face,
      );
      const completed = pending ? null : canonicalSession(await navigation);
      if (pending) {
        await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
      }
      const request = pending ? h.request : installShortResolver(context, [currentSession]);
      if (replaced === "hello") {
        snapshot.hello = hello();
      } else {
        snapshot.client = createTestGatewayClient(request);
      }
      deferred.resolve({ ok: true, ...oldSession, agentId: "roboclaw" });
      const resolved = completed ?? canonicalSession(await navigation);
      expect(resolved.sessionKey).toBe(oldSession.key);
      await expect(load(context, resolved.canonicalLocation, face)).resolves.toMatchObject({
        kind: "session",
        sessionKey: currentSession.key,
      });
      expect(request).toHaveBeenCalledTimes(pending ? 2 : 1);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("prefers the current location key over a residual colliding handoff", async () => {
    const current = monitor("0aaa-4000-8000-000000000001");
    const residual = monitor("0bbb-4000-8000-000000000002");
    const { context, list } = contextFor({ ok: false }, [current, residual]);
    const pathname = "/chat/roboclaw/deploy-monitor-12345678";
    prepareSessionNavigationHandoff(context.gateway, pathname, residual.key);

    const loaded = await load(
      context,
      locationFor(pathname, `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(current.key)}`),
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: current.key });
    expect(list).not.toHaveBeenCalled();

    const canonicalReload = await load(context, locationFor(pathname));
    expect(canonicalReload).toMatchObject({ kind: "session", sessionKey: current.key });
    expect(list).not.toHaveBeenCalled();
  });

  it("does not trust a URL-only full key that is absent from cached rows", async () => {
    const expected = monitor("0aaa-4000-8000-000000000001");
    const staleKey = "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002";
    const { context, list } = contextFor();
    const request = installShortResolver(context, [expected]);

    const loaded = await load(
      context,
      locationFor(
        "/chat/roboclaw/deploy-monitor-12345678",
        `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(staleKey)}`,
      ),
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: expected.key });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("resolved exact session identity", () => {
  it("clears a retained Incognito navigation hint without changing its exact identity or draft", async () => {
    const { context, request, list } = contextFor();
    const sessionKey = "agent:main:dashboard:incognito-12345678-aaaa-4000-8000-000000000001";
    const location = {
      pathname: "/chat/main/dashboard/incognito-12345678-aaaa-4000-8000-000000000001",
      search: `?${new URLSearchParams({
        [SESSION_NAVIGATION_KEY_PARAM]: sessionKey,
        draft: "Continue this conversation",
        dashboard: "expanded",
      })}`,
      hash: "",
    };
    const loaded = await load(context, location);
    expect(loaded).toMatchObject({
      kind: "session",
      sessionKey,
      draft: "Continue this conversation",
      dashboardExpanded: true,
      canonicalLocation: {
        ...location,
        search: "?draft=Continue+this+conversation&dashboard=expanded",
      },
      canonicalLocationSource: location,
    });
    expect(request).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["chat", "dashboard"] as const)(
    "keeps a literal selection reloadable after adopting its %s face",
    async (face) => {
      const session = (suffix: string) => ({
        key: `agent:main:thread:12345678-${suffix}`,
        boardFace: face,
        displayName: "Shared session title",
      });
      const selected = session("aaaa-4000-8000-000000000001");
      const fixtures = createControlUiSessionFixtures(
        {
          rows: [selected, session("bbbb-4000-8000-000000000002")],
          mainKey: "agent:main:main",
        },
        isRecord,
      );
      const createContext = () => {
        const result = contextFor();
        result.request.mockImplementation(async (method, params) => {
          expect(method).toBe("sessions.resolve");
          if (!isRecord(params)) {
            throw new Error("Missing resolution parameters");
          }
          if (typeof params.shortId === "string") {
            return fixtures.resolve({ shortId: params.shortId, agentId: "main" });
          }
          expect(params).toMatchObject({ reference: { key: selected.key }, agentId: "main" });
          return fixtures.resolve({ reference: { key: selected.key }, agentId: "main" });
        });
        return result;
      };
      const opened = createContext();
      const target = sessionNavigationTarget({
        context: opened.context,
        face: "chat",
        sessionKey: selected.key,
        preferenceDerivedFace: true,
        exactKey: true,
      });
      expect(target.options.pathname).toBe(
        "/chat/main/thread/12345678-aaaa-4000-8000-000000000001",
      );
      const loaded = canonicalSession(await load(opened.context, targetLocation(target)));
      expect(loaded).toMatchObject({ kind: "session", sessionKey: selected.key, face });
      // A new connection cannot reuse the first load's in-memory navigation handoff.
      const reloaded = createContext();
      await expect(load(reloaded.context, loaded.canonicalLocation, face)).resolves.toMatchObject({
        kind: "session",
        sessionKey: selected.key,
        face,
      });
      expect(reloaded.request).toHaveBeenCalledExactlyOnceWith(
        "sessions.resolve",
        expect.objectContaining({ shortId: "12345678aaaa40008000000000000001", agentId: "main" }),
      );
      expect([opened.list.mock.calls, reloaded.list.mock.calls]).toEqual([[], []]);
    },
  );
});
