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
import {
  createSessionRouteContext as contextFor,
  createSessionRouteRow as row,
  installShortSessionResolver as installShortResolver,
  sessionRouteLocation as targetLocation,
  sessionRouteKey as sessionKey,
  sessionRouteUuid as uuid,
} from "./route-resolution.test-support.ts";

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
      loadChatRoute(
        context,
        {
          pathname: "/chat/research",
          search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
          hash: "",
        },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: "global",
      agentId: "research",
      draft: undefined,
      face: "dashboard",
      canonicalLocation: { pathname: "/dashboard/research", search: "", hash: "" },
      canonicalLocationSource: {
        pathname: "/chat/research",
        search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
        hash: "",
      },
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

  it("applies an uncached stored face to a preference-derived open", async () => {
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

    expect(face).toBe("chat");
    expect(target.options.pathname).toBe("/chat/roboclaw/1234567890abcdef1234567890abcdef");
    await expect(
      loadChatRoute(context, targetLocation(target), face, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: dashboardRow.key,
      // The loader adopts the stored face, so the page renders the dashboard board and
      // replaces the URL into the matching namespace.
      face: "dashboard",
      canonicalLocation: {
        pathname:
          "/dashboard/roboclaw/default-mode-with-rare-surprises-1234567890abcdef1234567890abcdef",
        search: "",
      },
    });
  });

  it("applies face canonicalization through the router's normalized location", async () => {
    const dashboardRow = row({ boardFace: "dashboard" });
    const { context } = contextFor();
    installShortResolver(context, [dashboardRow]);
    const target = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey: dashboardRow.key,
      preferenceDerivedFace: true,
    });
    const search = new URLSearchParams(targetLocation(target).search);
    search.set(INTERNAL_SESSION_PATH_PARAM, target.options.pathname);

    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat", search: `?${search.toString()}`, hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: dashboardRow.key,
      canonicalLocation: {
        pathname:
          "/dashboard/roboclaw/default-mode-with-rare-surprises-1234567890abcdef1234567890abcdef",
        search: "",
      },
    });
  });

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

    await expect(
      loadChatRoute(context, targetLocation(target), "chat", new AbortController().signal),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: `agent:roboclaw:${catalogKey}`,
      agentId: "roboclaw",
      draft: undefined,
      face: "dashboard",
      canonicalLocation: {
        pathname: "/dashboard/roboclaw",
        search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1",
        hash: "",
      },
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
      candidates: rows.map((session) => ({
        key: session.key,
        agentId: session.key.split(":")[1]!,
        displayName: session.displayName ?? undefined,
        boardFace: session.boardFace ?? undefined,
      })),
    });
    const loaded = await loadChatRoute(
      context,
      {
        pathname: "/chat/roboclaw/default-mode-with-rare-surprises",
        search: "",
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({
      kind: "ambiguous",
      shortId: "default-mode-with-rare-surprises",
      truncated: false,
      candidates: [{ agentId: "roboclaw" }, { agentId: "research" }],
    });
    if (!("kind" in loaded) || loaded.kind !== "ambiguous") {
      throw new Error("expected slug disambiguation");
    }
    // Slug ties reuse the short-id disambiguation prefix instead of a full uuid, so the
    // offered links stay as short as uniqueness allows.
    expect(loaded.candidates.map((candidate) => candidate.href)).toEqual([
      "/chat/roboclaw/default-mode-with-rare-surprises-123456780a",
      "/chat/research/default-mode-with-rare-surprises-123456780b",
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it("fails visibly when the gateway rejects authoritative short-id resolution", async () => {
    const { context, list } = contextFor();
    const rejection = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "invalid sessions.resolve params: at root: unexpected property 'shortId'",
    });
    const request = vi.fn(async () => {
      throw rejection;
    });
    (context.gateway.snapshot.client as unknown as { request: typeof request }).request = request;

    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/roboclaw/deploy-monitor-12345678", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).rejects.toBe(rejection);
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["short", "reference"] as const)(
    "rejects a %s result after navigation ownership is aborted",
    async (kind) => {
      const storedRow = row({ displayName: "Deploy monitor" });
      const { context, list } = contextFor();
      const resolution = createDeferred<SessionsResolveResult>();
      const request = vi.fn(() => resolution.promise);
      (context.gateway.snapshot.client as unknown as { request: typeof request }).request = request;
      const controller = new AbortController();
      const pathname =
        kind === "short"
          ? "/chat/roboclaw/deploy-monitor-12345678"
          : "/dashboard/roboclaw/deploy-monitor";
      const navigation = loadChatRoute(
        context,
        { pathname, search: "", hash: "" },
        kind === "short" ? "chat" : "dashboard",
        controller.signal,
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const reason = new Error("navigation superseded");
      controller.abort(reason);
      const reply = { ok: true, key: storedRow.key, agentId: "roboclaw" } as const;
      resolution.resolve(reply);

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
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/12345678", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "ambiguous", shortId: "12345678", truncated: true });
  });

  it("opens a mechanically composed single-segment UUID as its exact session key", async () => {
    const literalKey = `agent:main:${uuid}`;
    const literalRow = row({ key: literalKey, displayName: undefined });
    const { context, list } = contextFor();
    const request = installShortResolver(context, [], { ok: false });
    request.mockResolvedValueOnce({ ok: false });
    request.mockResolvedValueOnce({ ok: true, ...literalRow, agentId: "main" });

    const loaded = await loadChatRoute(
      context,
      { pathname: `/chat/main/${uuid}`, search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

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
    const literalUuid = "12345678-90ab-cdef-1234-567890abcdef";
    const collidingUuid = "567890ab-cdef-4321-8765-43210fedcba9";
    const literal = row({
      key: `agent:main:${literalUuid}`,
      sessionId: literalUuid,
      displayName: undefined,
    });
    const shortMatch = row({
      key: `agent:main:thread:${collidingUuid}`,
      sessionId: collidingUuid,
      displayName: undefined,
    });
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

    expect(chipTarget.options.pathname).toBe(`/chat/main/~key/${literalUuid}`);

    await expect(
      loadChatRoute(context, targetLocation(chipTarget), "chat", new AbortController().signal),
    ).resolves.toMatchObject({ kind: "session", sessionKey: literal.key });

    // Plain literal paths remain short-first, so this collision opens the short match.
    // Tool-generated links advertise `~key` to bypass that intentional ambiguity.
    await expect(
      loadChatRoute(
        context,
        { pathname: `/chat/main/${literalUuid}`, search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "session", sessionKey: shortMatch.key });
    expect(request).toHaveBeenCalledWith(
      "sessions.resolve",
      expect.objectContaining({ shortId: "567890abcdef" }),
    );
  });

  it.each([{ pathname: "/chat/roboclaw/existing-literal", search: "" }])(
    "surfaces current reference lookup errors for $pathname",
    async ({ pathname, search }) => {
      const error = new Error("lookup unavailable");
      const { context, list, request } = contextFor(error);
      await expect(
        loadChatRoute(
          context,
          { pathname, search, hash: "" },
          "chat",
          new AbortController().signal,
        ),
      ).rejects.toBe(error);
      expect(request).toHaveBeenCalledOnce();
      expect(list).not.toHaveBeenCalled();
    },
  );

  it.each(["response", "error"] as const)(
    "ignores an obsolete connection's reference %s",
    async (outcome) => {
      const { context, list } = contextFor();
      const pending = createDeferred<SessionsResolveResult>();
      const request = vi.fn(() => pending.promise);
      (context.gateway.snapshot.client as unknown as { request: typeof request }).request = request;
      const navigation = loadChatRoute(
        context,
        { pathname: "/chat/roboclaw/existing-literal", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      );
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
