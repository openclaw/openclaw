// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import {
  resolveSessionPreferredFaceForKey,
  SESSION_FACE_PREFERENCE_PARAM,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { loadChatRoute } from "./route-loader.ts";
import { loadRoute, routeLocation as locationFor } from "./route-loading.test-support.ts";
import {
  createSessionRouteContext as contextFor,
  createSessionRouteRow as row,
  installShortSessionResolver as installShortResolver,
  sessionRouteLocation as targetLocation,
  sessionRouteKey as sessionKey,
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
      pending.resolve({ ok: true, key: sessionKey, agentId: "roboclaw" });

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
        pending.resolve({ ok: true, key: sessionKey, agentId: "roboclaw" });
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
