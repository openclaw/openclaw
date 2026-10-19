// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { prepareSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import {
  SESSION_COMPOSER_FOCUS_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { locationWithoutDraft } from "./route-draft.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  createSessionRouteContext as contextFor,
  createSessionRouteRow as row,
  installShortSessionResolver as installShortResolver,
} from "./route-resolution.test-support.ts";

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
      const first = await loadChatRoute(
        context,
        {
          pathname,
          search: `${search}&${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(sessionKey)}`,
          hash: "",
        },
        "chat",
        new AbortController().signal,
      );
      if (!("kind" in first) || first.kind !== "session" || !first.canonicalLocation) {
        throw new Error("Expected navigation-key cleanup");
      }
      expect(first.canonicalLocation.search).toBe(search);
      await expect(
        loadChatRoute(context, first.canonicalLocation, "chat", new AbortController().signal),
      ).resolves.toMatchObject({ kind: "session", sessionKey });
      expect(request).not.toHaveBeenCalled();
      if (reconnect) {
        context.gateway.snapshot.hello = gatewayHelloForMethods(["sessions.resolve"]);
      }
      const cleaned = await loadChatRoute(
        context,
        locationWithoutDraft(first.canonicalLocation),
        "chat",
        new AbortController().signal,
      );
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
    const loaded = await loadChatRoute(
      context,
      { pathname: target.options.pathname, search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({
      kind: "session",
      sessionKey: storedRow.key,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    {
      connectionChange: "gateway client replacement",
      replaceConnection: (snapshot: ApplicationContext["gateway"]["snapshot"]) => {
        const request = (snapshot.client as { request?: unknown } | null)?.request;
        snapshot.client = { request } as NonNullable<typeof snapshot.client>;
      },
    },
    {
      connectionChange: "hello replacement on the same gateway client",
      replaceConnection: (snapshot: ApplicationContext["gateway"]["snapshot"]) => {
        snapshot.hello = {
          snapshot: { sessionDefaults: { mainKey: "main" } },
        } as NonNullable<typeof snapshot.hello>;
      },
    },
  ])("does not trust a carried session after $connectionChange", async ({ replaceConnection }) => {
    const oldSession = row({
      key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
      displayName: "Deploy monitor",
    });
    const currentSession = row({
      key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002",
      displayName: "Deploy monitor",
    });
    const { context, list } = contextFor({ ok: true, ...oldSession, agentId: "roboclaw" });
    context.gateway.snapshot.hello = {
      snapshot: { sessionDefaults: { mainKey: "main" } },
    } as NonNullable<typeof context.gateway.snapshot.hello>;
    const resolved = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/deploy-monitor", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );
    if (!("kind" in resolved) || resolved.kind !== "session" || !resolved.canonicalLocation) {
      throw new Error("Expected a canonical session location");
    }
    const request = installShortResolver(context, [currentSession]);
    replaceConnection(context.gateway.snapshot);

    const loaded = await loadChatRoute(
      context,
      resolved.canonicalLocation,
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: currentSession.key });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["client", "hello"] as const)(
    "does not rebind an in-flight short result after %s replacement",
    async (replaced) => {
      const oldSession = row({
        key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
        displayName: "Deploy monitor",
      });
      const currentSession = row({
        key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002",
        displayName: "Deploy monitor",
      });
      const { context, request } = contextFor({ ok: true, ...currentSession, agentId: "roboclaw" });
      const pending = createDeferred<SessionsResolveResult>();
      request.mockImplementationOnce(() => pending.promise);
      const navigation = loadChatRoute(
        context,
        { pathname: "/dashboard/roboclaw/old-name-12345678", search: "", hash: "" },
        "dashboard",
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      if (replaced === "client") {
        context.gateway.snapshot.client = createTestGatewayClient(request);
      } else {
        context.gateway.snapshot.hello = {
          snapshot: { sessionDefaults: { mainKey: "main" } },
        } as NonNullable<typeof context.gateway.snapshot.hello>;
      }
      pending.resolve({ ok: true, ...oldSession, agentId: "roboclaw" });
      const resolved = await navigation;
      if (!("kind" in resolved) || resolved.kind !== "session" || !resolved.canonicalLocation) {
        throw new Error("Expected a canonical session location");
      }
      expect(resolved.sessionKey).toBe(oldSession.key);
      await expect(
        loadChatRoute(
          context,
          resolved.canonicalLocation,
          "dashboard",
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ kind: "session", sessionKey: currentSession.key });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("prefers the current location key over a residual colliding handoff", async () => {
    const current = row({
      key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
      displayName: "Deploy monitor",
    });
    const residual = row({
      key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002",
      displayName: "Deploy monitor",
    });
    const { context, list } = contextFor({ ok: false }, [current, residual]);
    const pathname = "/chat/roboclaw/deploy-monitor-12345678";
    prepareSessionNavigationHandoff(context.gateway, pathname, residual.key);

    const loaded = await loadChatRoute(
      context,
      {
        pathname,
        search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(current.key)}`,
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: current.key });
    expect(list).not.toHaveBeenCalled();

    const canonicalReload = await loadChatRoute(
      context,
      { pathname, search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );
    expect(canonicalReload).toMatchObject({ kind: "session", sessionKey: current.key });
    expect(list).not.toHaveBeenCalled();
  });

  it("does not trust a URL-only full key that is absent from cached rows", async () => {
    const expected = row({
      key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
      displayName: "Deploy monitor",
    });
    const staleKey = "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002";
    const { context, list } = contextFor();
    const request = installShortResolver(context, [expected]);

    const loaded = await loadChatRoute(
      context,
      {
        pathname: "/chat/roboclaw/deploy-monitor-12345678",
        search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(staleKey)}`,
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: expected.key });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });
});
