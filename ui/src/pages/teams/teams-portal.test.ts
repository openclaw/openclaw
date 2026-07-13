/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayBrowserClientOptions } from "../../api/gateway.ts";
import {
  buildTeamsInviteLink,
  consumeInviteCodeFromFragment,
  isTeamsPortalPath,
  renderTeamsPortal,
  TeamsPortalStore,
  type TeamsPortalGateway,
} from "./teams-portal.ts";

function authenticatedSession(expiresAt = Date.now() + 60_000) {
  return {
    authenticated: true as const,
    principal: { issuer: "openclaw-local", subject: "ada", kind: "human" as const },
    domainId: "domain-1",
    expiresAt,
  };
}

function tabResult(mode: "read" | "request" | "write" = "read") {
  return {
    workspaceId: "workspace-1",
    workspaceVersion: 8,
    capabilityMode: mode,
    presence: [
      { id: "ada", kind: "human", self: true },
      { id: "review-agent", kind: "agent", self: false },
    ],
    tab: {
      id: "tab-1",
      revision: 4,
      slug: "planning",
      title: "Planning",
      hidden: false,
      widgets: [{ id: "widget-1", kind: "builtin:markdown", title: "Roadmap" }],
    },
  };
}

function createGateway(response = tabResult()): TeamsPortalGateway & {
  request: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    request: vi.fn(async () => response),
    stop: vi.fn(),
  };
}

function createStore(params: {
  session?: ReturnType<typeof authenticatedSession>;
  gateway?: ReturnType<typeof createGateway>;
  gatewayOptions?: (options: GatewayBrowserClientOptions) => void;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) {
  const gateway = params.gateway ?? createGateway();
  const defaultFetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/teams/session")) {
      return new Response(JSON.stringify(params.session ?? authenticatedSession()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/teams/invites/accept")) {
      return new Response(
        JSON.stringify({
          session: params.session ?? authenticatedSession(),
          destination: { workspaceId: "workspace-1", tabId: "tab-1" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(params.session ?? authenticatedSession()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const store = new TeamsPortalStore({
    fetcher: params.fetcher ?? defaultFetcher,
    gatewayFactory: (options) => {
      params.gatewayOptions?.(options);
      options.onHello?.({
        type: "hello-ok",
        protocol: 1,
        auth: { role: "member", scopes: [] },
      });
      return gateway as unknown as GatewayBrowserClient;
    },
    gatewayUrl: "wss://gateway.example",
  });
  return { store, gateway, fetcher: params.fetcher ?? defaultFetcher };
}

describe("Teams public route", () => {
  it("recognizes only the restricted Teams login and invite paths", () => {
    expect(isTeamsPortalPath("/teams")).toBe("login");
    expect(isTeamsPortalPath("/base/teams/invite")).toBe("invite");
    expect(isTeamsPortalPath("/teams/settings")).toBeNull();
  });

  it("consumes an opaque invite from the fragment and strips it immediately", () => {
    const replaceState = vi.fn();
    const location = {
      pathname: "/teams/invite",
      search: "?workspaceId=workspace-1&tabId=tab-1",
      hash: "#invite-secret",
    };

    const code = consumeInviteCodeFromFragment(location, { replaceState });

    expect(code).toBe("invite-secret");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/teams/invite?workspaceId=workspace-1&tabId=tab-1",
    );
    expect(replaceState.mock.calls.flat().join(" ")).not.toContain("invite-secret");
  });

  it("rejects invite codes supplied through the query string", () => {
    const replaceState = vi.fn();

    expect(
      consumeInviteCodeFromFragment(
        { pathname: "/teams/invite", search: "?code=invite-secret", hash: "" },
        { replaceState },
      ),
    ).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("creates one-time owner links with the invite code only in the fragment", () => {
    const link = buildTeamsInviteLink({
      location: { origin: "https://teams.example", pathname: "/base/teams" },
      workspaceId: "workspace-1",
      tabId: "tab-1",
      code: "opaque invite code",
    });

    expect(link).toBe(
      "https://teams.example/base/teams/invite?workspaceId=workspace-1&tabId=tab-1#opaque%20invite%20code",
    );
    expect(new URL(link).searchParams.has("code")).toBe(false);
  });
});

describe("Teams portal store", () => {
  it("connects as a member and requests only the exact shared tab", async () => {
    let options: GatewayBrowserClientOptions | undefined;
    const { store, gateway } = createStore({ gatewayOptions: (value) => (options = value) });

    await store.start({
      route: "login",
      workspaceId: "workspace-1",
      tabId: "tab-1",
    });

    expect(options).toMatchObject({ role: "member", scopes: [] });
    expect(gateway.request).toHaveBeenCalledWith("workspaces.tab.get", {
      workspaceId: "workspace-1",
      id: "tab-1",
    });
    expect(gateway.request.mock.calls.some(([method]) => method === "workspaces.get")).toBe(false);
    expect(store.snapshot.presence).toEqual(tabResult().presence);
  });

  it("refreshes presence by polling only the same exact tab", async () => {
    vi.useFakeTimers();
    try {
      const { store, gateway } = createStore({});
      await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
      const before = gateway.request.mock.calls.filter(
        ([method]) => method === "workspaces.tab.get",
      ).length;

      await vi.advanceTimersByTimeAsync(10_000);

      const exactReads = gateway.request.mock.calls.filter(
        ([method]) => method === "workspaces.tab.get",
      );
      expect(exactReads).toHaveLength(before + 1);
      expect(exactReads.at(-1)).toEqual([
        "workspaces.tab.get",
        { workspaceId: "workspace-1", id: "tab-1" },
      ]);
      expect(gateway.request.mock.calls.some(([method]) => method === "workspaces.get")).toBe(
        false,
      );
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for an in-flight presence refresh before scheduling the next poll", async () => {
    vi.useFakeTimers();
    try {
      let tabReads = 0;
      let resolvePresence!: (value: ReturnType<typeof tabResult>) => void;
      const pendingPresence = new Promise<ReturnType<typeof tabResult>>((resolve) => {
        resolvePresence = resolve;
      });
      const gateway = {
        request: vi.fn((method: string) => {
          if (method === "workspaces.tab.get") {
            tabReads += 1;
            return tabReads === 1 ? Promise.resolve(tabResult()) : pendingPresence;
          }
          return Promise.resolve(tabResult());
        }),
        stop: vi.fn(),
      };
      const { store } = createStore({ gateway });
      await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(tabReads).toBe(2);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(tabReads).toBe(2);

      resolvePresence(tabResult());
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(tabReads).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(tabReads).toBe(3);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncs owner sharing before loading the exact tab and selects that tab by default", async () => {
    const gateway = {
      request: vi.fn(async (method: string, _params?: unknown) => {
        if (method === "workspaces.sharing.sync") {
          return {
            tabs: [
              { id: "tab-1", revision: 4, slug: "planning", title: "Planning" },
              { id: "tab-2", revision: 2, slug: "review", title: "Review" },
            ],
          };
        }
        if (method === "workspaces.changeRequest.list") {
          return {
            requests: [
              {
                id: "request-1",
                requester: { principalId: "ada", kind: "human" },
                proposal: { title: "Revised planning" },
              },
            ],
          };
        }
        return tabResult();
      }),
      stop: vi.fn(),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/teams/session")) {
        return new Response(JSON.stringify(authenticatedSession()), { status: 200 });
      }
      if (path.endsWith("/api/teams/invite-presets")) {
        return new Response(JSON.stringify({ presets: ["read"] }), { status: 200 });
      }
      if (path.endsWith("/api/teams/invites")) {
        return new Response(JSON.stringify({ invites: [] }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { store } = createStore({
      fetcher,
      gateway: gateway as unknown as ReturnType<typeof createGateway>,
    });

    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });

    expect(gateway.request).toHaveBeenNthCalledWith(1, "workspaces.sharing.sync", {
      workspaceId: "workspace-1",
    });
    expect(gateway.request).toHaveBeenNthCalledWith(2, "workspaces.tab.get", {
      workspaceId: "workspace-1",
      id: "tab-1",
    });
    expect(store.snapshot.selectedShareTabId).toBe("tab-1");
    expect(store.snapshot.shareTabs?.map((tab) => tab.id)).toEqual(["tab-1", "tab-2"]);
    expect(gateway.request).toHaveBeenNthCalledWith(3, "workspaces.changeRequest.list", {
      workspaceId: "workspace-1",
      tabId: "tab-1",
      state: "pending",
    });
    expect(store.snapshot.pendingChangeRequests?.[0]).toMatchObject({
      id: "request-1",
      requester: "ada",
      proposedTitle: "Revised planning",
    });
  });

  it("lets an owner decide a pending change request and refreshes the review list", async () => {
    let listed = 0;
    const gateway = {
      request: vi.fn(async (method: string, params?: unknown) => {
        if (method === "workspaces.sharing.sync") {
          return { tabs: [{ id: "tab-1", revision: 4, slug: "planning", title: "Planning" }] };
        }
        if (method === "workspaces.changeRequest.list") {
          listed += 1;
          return listed === 1
            ? {
                requests: [
                  {
                    id: "request-1",
                    requester: { principalId: "ada", kind: "human" },
                    proposal: { title: "Revised planning" },
                  },
                ],
              }
            : { requests: [] };
        }
        if (method === "workspaces.changeRequest.decide") {
          return {
            workspaceId: "workspace-1",
            applied: true,
            tab: { ...tabResult("write").tab, revision: 5, title: "Revised planning" },
          };
        }
        if (method === "workspaces.tab.update") {
          return {
            workspaceId: "workspace-1",
            tab: {
              ...tabResult("write").tab,
              revision: 6,
              title: (params as { patch: { title: string } }).patch.title,
            },
          };
        }
        return method === "workspaces.tab.get" ? tabResult("write") : { ok: true };
      }),
      stop: vi.fn(),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/teams/session")) {
        return new Response(JSON.stringify(authenticatedSession()), { status: 200 });
      }
      if (path.endsWith("/api/teams/invite-presets")) {
        return new Response(JSON.stringify({ presets: ["read"] }), { status: 200 });
      }
      if (path.endsWith("/api/teams/invites")) {
        return new Response(JSON.stringify({ invites: [] }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { store } = createStore({
      fetcher,
      gateway: gateway as unknown as ReturnType<typeof createGateway>,
    });
    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });

    await store.decideOwnerChangeRequest({ requestId: "request-1", decision: "approved" });

    expect(gateway.request).toHaveBeenCalledWith("workspaces.changeRequest.decide", {
      workspaceId: "workspace-1",
      tabId: "tab-1",
      requestId: "request-1",
      decision: "approved",
    });
    expect(gateway.request).toHaveBeenLastCalledWith("workspaces.changeRequest.list", {
      workspaceId: "workspace-1",
      tabId: "tab-1",
      state: "pending",
    });
    expect(store.snapshot.pendingChangeRequests).toEqual([]);
    expect(store.snapshot.tab).toMatchObject({ revision: 5, title: "Revised planning" });

    store.setDraftTitle("Owner follow-up");
    await store.submitDraft();
    expect(gateway.request).toHaveBeenCalledWith(
      "workspaces.tab.update",
      expect.objectContaining({ ifRevision: 5 }),
    );
  });

  it("submits request-mode edits as a proposal instead of a direct write", async () => {
    const gateway = createGateway(tabResult("request"));
    const { store } = createStore({ gateway });
    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });

    store.setDraftTitle("Requested title");
    await store.submitDraft();

    expect(gateway.request).toHaveBeenCalledWith(
      "workspaces.changeRequest.create",
      expect.objectContaining({
        workspaceId: "workspace-1",
        tabId: "tab-1",
        baseRevision: 4,
        idempotencyKey: expect.stringMatching(/^portal-/),
        proposal: expect.objectContaining({ title: "Requested title" }),
      }),
    );
    expect(gateway.request.mock.calls.some(([method]) => method === "workspaces.tab.update")).toBe(
      false,
    );
  });

  it("writes an exact tab id with optimistic revision in write mode", async () => {
    const gateway = createGateway(tabResult("write"));
    const { store } = createStore({ gateway });
    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });

    store.setDraftTitle("Written title");
    await store.submitDraft();

    expect(gateway.request).toHaveBeenCalledWith("workspaces.tab.update", {
      workspaceId: "workspace-1",
      id: "tab-1",
      ifRevision: 4,
      patch: { title: "Written title" },
    });
  });

  it("adopts the server revision after each write and strips untrusted tab fields", async () => {
    let revision = 4;
    const gateway = {
      request: vi.fn(async (method: string, params?: unknown) => {
        if (method === "workspaces.sharing.sync") {
          throw new Error("member");
        }
        if (method === "workspaces.tab.get") {
          return tabResult("write");
        }
        if (method === "workspaces.tab.update") {
          revision += 1;
          const title = (params as { patch: { title: string } }).patch.title;
          return {
            workspaceId: "workspace-1",
            tab: {
              ...tabResult("write").tab,
              revision,
              title,
              widgets: [
                {
                  id: "widget-1",
                  kind: "builtin:markdown",
                  title: "Roadmap",
                  props: { secret: "do-not-retain" },
                  bindings: { source: { source: "file", path: "private.json" } },
                },
              ],
            },
          };
        }
        return { requests: [] };
      }),
      stop: vi.fn(),
    };
    const { store } = createStore({
      gateway: gateway as unknown as ReturnType<typeof createGateway>,
    });
    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });

    store.setDraftTitle("First");
    await store.submitDraft();
    store.setDraftTitle("Second");
    await store.submitDraft();

    const writes = gateway.request.mock.calls.filter(
      ([method]) => method === "workspaces.tab.update",
    );
    expect(writes[0]?.[1]).toMatchObject({ ifRevision: 4 });
    expect(writes[1]?.[1]).toMatchObject({ ifRevision: 5 });
    expect(store.snapshot.tab).toMatchObject({ revision: 6, title: "Second" });
    expect(JSON.stringify(store.snapshot.tab)).not.toContain("do-not-retain");
    expect(JSON.stringify(store.snapshot.tab)).not.toContain("private.json");
  });

  it("clears the cached tab on logout and session expiry", async () => {
    const { store, fetcher } = createStore({});
    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    expect(store.snapshot.tab?.id).toBe("tab-1");

    await store.logout();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/teams/logout",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(store.snapshot.tab).toBeNull();

    const second = createStore({});
    await second.store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    second.store.expireSession();
    expect(second.store.snapshot.tab).toBeNull();
    expect(second.store.snapshot.status).toBe("signed-out");
  });

  it("uses credentialed same-origin calls for login and invite acceptance", async () => {
    const { store, fetcher } = createStore({});

    await store.login({
      loginLabel: "ada@example.com",
      password: "correct horse battery staple",
      domainId: "domain-1",
    });
    await store.acceptInvite({
      code: "invite-secret",
      loginLabel: "ada@example.com",
      password: "correct horse battery staple",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/teams/login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/teams/invites/accept",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("uses the server-authoritative invite destination even without URL routing hints", async () => {
    const { store, gateway } = createStore({});
    await store.start({ route: "invite", inviteCode: "invite-secret" });

    await store.acceptInvite({
      loginLabel: "ada@example.com",
      password: "correct horse battery staple",
    });

    expect(gateway.request).toHaveBeenCalledWith("workspaces.tab.get", {
      workspaceId: "workspace-1",
      id: "tab-1",
    });
    expect(store.snapshot.workspaceId).toBe("workspace-1");
    expect(store.snapshot.tabId).toBe("tab-1");
  });

  it("settles a failed pre-hello websocket instead of remaining loading", async () => {
    let options: GatewayBrowserClientOptions | undefined;
    const gateway = { request: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const store = new TeamsPortalStore({
      fetcher: vi.fn(
        async () => new Response(JSON.stringify(authenticatedSession()), { status: 200 }),
      ),
      gatewayFactory: (value) => {
        options = value;
        return gateway as unknown as GatewayBrowserClient;
      },
      gatewayUrl: "wss://gateway.example",
    });
    const start = store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    await vi.waitFor(() => expect(options).toBeDefined());
    options?.onClose?.({ code: 1008, reason: "internal detail", willRetry: false });
    await start;

    expect(store.snapshot.status).toBe("error");
    expect(store.snapshot.tab).toBeNull();
    expect(gateway.request).not.toHaveBeenCalled();
    expect(store.snapshot.error).not.toContain("internal detail");
  });

  it("lets an owner create a preset invite for the exact tab and revoke it", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/teams/session")) {
        return new Response(JSON.stringify(authenticatedSession()), { status: 200 });
      }
      if (path.endsWith("/api/teams/invite-presets")) {
        return new Response(JSON.stringify({ presets: ["read", "request", "write"] }), {
          status: 200,
        });
      }
      if (path.endsWith("/api/teams/invites") && !init?.method) {
        return new Response(JSON.stringify({ invites: [] }), { status: 200 });
      }
      if (path.endsWith("/api/teams/invites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            invite: {
              id: "invite-1",
              preset: "write",
              tabId: "tab-1",
              state: "active",
              createdAt: 1,
              expiresAt: Date.now() + 60_000,
            },
            code: "one-time-code",
          }),
          { status: 201 },
        );
      }
      if (path.endsWith("/api/teams/invites/invite-1") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { store } = createStore({ fetcher });

    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    await store.createOwnerInvite({ preset: "write", recipientLabel: "Ada" });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/teams/invites",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          workspaceId: "workspace-1",
          tabId: "tab-1",
          preset: "write",
          recipientLabel: "Ada",
        }),
      }),
    );
    expect(store.snapshot.oneTimeInviteLink).toContain("#one-time-code");
    expect(
      new URL(store.snapshot.oneTimeInviteLink ?? "https://invalid.example").searchParams.has(
        "code",
      ),
    ).toBe(false);
    expect(store.snapshot.ownerInvites).toEqual([
      expect.objectContaining({ id: "invite-1", preset: "write" }),
    ]);

    await store.revokeOwnerInvite("invite-1");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/teams/invites/invite-1",
      expect.objectContaining({ method: "DELETE", credentials: "include", body: "{}" }),
    );
    expect(store.snapshot.ownerInvites).toEqual([]);
  });

  it("does not show a late invite link under a newly selected tab", async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    const gateway = {
      request: vi.fn(async (method: string) => {
        if (method === "workspaces.sharing.sync") {
          return {
            tabs: [
              { id: "tab-1", revision: 4, slug: "planning", title: "Planning" },
              { id: "tab-2", revision: 1, slug: "review", title: "Review" },
            ],
          };
        }
        if (method === "workspaces.changeRequest.list") {
          return { requests: [] };
        }
        return tabResult();
      }),
      stop: vi.fn(),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/teams/session")) {
        return new Response(JSON.stringify(authenticatedSession()), { status: 200 });
      }
      if (path.endsWith("/api/teams/invite-presets")) {
        return new Response(JSON.stringify({ presets: ["read"] }), { status: 200 });
      }
      if (path.endsWith("/api/teams/invites") && !init?.method) {
        return new Response(JSON.stringify({ invites: [] }), { status: 200 });
      }
      if (path.endsWith("/api/teams/invites") && init?.method === "POST") {
        return await new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { store } = createStore({
      fetcher,
      gateway: gateway as unknown as ReturnType<typeof createGateway>,
    });
    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    const create = store.createOwnerInvite({ preset: "read" });
    await vi.waitFor(() => expect(resolveCreate).toBeDefined());
    store.setSelectedShareTabId("tab-2");
    resolveCreate?.(
      new Response(
        JSON.stringify({
          invite: {
            id: "invite-a",
            preset: "read",
            tabId: "tab-1",
            state: "active",
            createdAt: 1,
            expiresAt: Date.now() + 60_000,
          },
          code: "code-a",
        }),
        { status: 201 },
      ),
    );
    await create;

    expect(store.snapshot.selectedShareTabId).toBe("tab-2");
    expect(store.snapshot.oneTimeInviteLink).toContain("#code-a");
    expect(store.snapshot.ownerInvites?.map((invite) => invite.id)).toContain("invite-a");
    const host = document.createElement("div");
    render(renderTeamsPortal(store.snapshot), host);
    expect(host.querySelector('[aria-label="One-time invite link"]')).toBeNull();
    store.setSelectedShareTabId("tab-1");
    render(renderTeamsPortal(store.snapshot), host);
    expect(
      (host.querySelector('[aria-label="One-time invite link"]') as HTMLInputElement).value,
    ).toContain("#code-a");
  });

  it("does not let a stale tab request failure clear the newly selected tab", async () => {
    let listCalls = 0;
    let rejectTabA: ((error: Error) => void) | undefined;
    let resolveTabB: ((value: unknown) => void) | undefined;
    const gateway = {
      request: vi.fn(async (method: string) => {
        if (method === "workspaces.sharing.sync") {
          return {
            tabs: [
              { id: "tab-1", revision: 4, slug: "planning", title: "Planning" },
              { id: "tab-2", revision: 1, slug: "review", title: "Review" },
            ],
          };
        }
        if (method === "workspaces.changeRequest.list") {
          listCalls += 1;
          if (listCalls === 1) {
            return { requests: [] };
          }
          if (listCalls === 2) {
            return await new Promise((_, reject) => {
              rejectTabA = reject;
            });
          }
          return await new Promise((resolve) => {
            resolveTabB = resolve;
          });
        }
        return tabResult();
      }),
      stop: vi.fn(),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/teams/session")) {
        return new Response(JSON.stringify(authenticatedSession()), { status: 200 });
      }
      if (path.endsWith("/api/teams/invite-presets")) {
        return new Response(JSON.stringify({ presets: ["read"] }), { status: 200 });
      }
      return new Response(JSON.stringify({ invites: [] }), { status: 200 });
    });
    const { store } = createStore({
      fetcher,
      gateway: gateway as unknown as ReturnType<typeof createGateway>,
    });
    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    store.setSelectedShareTabId("tab-1");
    store.setSelectedShareTabId("tab-2");
    await vi.waitFor(() => {
      expect(rejectTabA).toBeDefined();
      expect(resolveTabB).toBeDefined();
    });
    resolveTabB?.({
      requests: [
        {
          id: "request-b",
          requester: { principalId: "member-b" },
          proposal: { title: "Review B" },
        },
      ],
    });
    await vi.waitFor(() => expect(store.snapshot.pendingChangeRequests?.[0]?.id).toBe("request-b"));
    rejectTabA?.(new Error("stale A failure"));
    await Promise.resolve();

    expect(store.snapshot.pendingChangeRequests?.[0]?.id).toBe("request-b");
  });

  it("hides owner sharing controls after a generic owner API failure without losing tab access", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/teams/session")) {
        return new Response(JSON.stringify(authenticatedSession()), { status: 200 });
      }
      if (path.endsWith("/api/teams/invite-presets")) {
        return new Response(JSON.stringify({ error: { message: "Not available" } }), {
          status: 403,
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { store } = createStore({ fetcher });
    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    const host = document.createElement("div");
    render(renderTeamsPortal(store.snapshot), host);

    expect(store.snapshot.tab?.id).toBe("tab-1");
    expect(store.snapshot.ownerSharing).toBe(false);
    expect(host.querySelector("[data-teams-owner-sharing]")).toBeNull();
  });

  it("filters owner invites to the selected tab and revokes only active links", () => {
    const host = document.createElement("div");
    render(
      renderTeamsPortal({
        status: "ready",
        route: "login",
        session: authenticatedSession(),
        tab: tabResult().tab,
        workspaceId: "workspace-1",
        tabId: "tab-1",
        mode: "read",
        draftTitle: "Planning",
        error: null,
        ownerSharing: true,
        selectedShareTabId: "tab-2",
        ownerInvites: [
          { id: "a", preset: "read", tabId: "tab-1", state: "active", createdAt: 1, expiresAt: 2 },
          {
            id: "b",
            preset: "write",
            tabId: "tab-2",
            state: "redeemed",
            createdAt: 1,
            expiresAt: 2,
          },
        ],
      }),
      host,
    );

    expect(host.textContent).toContain("Read + write redeemed");
    expect(host.textContent).not.toContain("Read active");
    expect(
      [...host.querySelectorAll("button")].some((button) => button.textContent === "Revoke"),
    ).toBe(false);
  });

  it("clears the one-time invite link on logout and session expiry", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/teams/session")) {
        return new Response(JSON.stringify(authenticatedSession()), { status: 200 });
      }
      if (path.endsWith("/api/teams/invite-presets")) {
        return new Response(JSON.stringify({ presets: ["read"] }), { status: 200 });
      }
      if (path.endsWith("/api/teams/invites") && !init?.method) {
        return new Response(JSON.stringify({ invites: [] }), { status: 200 });
      }
      if (path.endsWith("/api/teams/invites") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            invite: {
              id: "invite-1",
              preset: "read",
              tabId: "tab-1",
              state: "active",
              createdAt: 1,
              expiresAt: Date.now() + 60_000,
            },
            code: "one-time-code",
          }),
          { status: 201 },
        );
      }
      if (path.endsWith("/api/teams/logout")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { store } = createStore({ fetcher });
    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    await store.createOwnerInvite({ preset: "read" });

    await store.logout();
    expect(store.snapshot.oneTimeInviteLink).toBeNull();

    await store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    await store.createOwnerInvite({ preset: "read" });
    store.expireSession();
    expect(store.snapshot.oneTimeInviteLink).toBeNull();
  });

  it("does not restore owner metadata when an in-flight response finishes after expiry", async () => {
    let resolvePresets: ((response: Response) => void) | undefined;
    let resolveInvites: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/teams/session")) {
        return new Response(JSON.stringify(authenticatedSession()), { status: 200 });
      }
      if (path.endsWith("/api/teams/invite-presets")) {
        return await new Promise<Response>((resolve) => {
          resolvePresets = resolve;
        });
      }
      if (path.endsWith("/api/teams/invites")) {
        return await new Promise<Response>((resolve) => {
          resolveInvites = resolve;
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    const { store } = createStore({ fetcher });
    const start = store.start({ route: "login", workspaceId: "workspace-1", tabId: "tab-1" });
    await vi.waitFor(() => {
      expect(resolvePresets).toBeDefined();
      expect(resolveInvites).toBeDefined();
    });

    store.expireSession();
    resolvePresets?.(new Response(JSON.stringify({ presets: ["write"] }), { status: 200 }));
    resolveInvites?.(
      new Response(
        JSON.stringify({
          invites: [
            {
              id: "late",
              preset: "write",
              tabId: "tab-1",
              state: "active",
              createdAt: 1,
              expiresAt: Date.now() + 60_000,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await start;

    expect(store.snapshot.status).toBe("signed-out");
    expect(store.snapshot.ownerSharing).toBe(false);
    expect(store.snapshot.ownerInvites).toEqual([]);
    expect(store.snapshot.invitePresets).toEqual([]);
  });
});

describe("restricted Teams shell", () => {
  it("labels owner grants as cumulative read capabilities", () => {
    const host = document.createElement("div");
    render(
      renderTeamsPortal({
        status: "ready",
        route: "login",
        session: authenticatedSession(),
        tab: tabResult("write").tab,
        workspaceId: "workspace-1",
        tabId: "tab-1",
        mode: "write",
        draftTitle: "Planning",
        error: null,
        ownerSharing: true,
        invitePresets: ["read", "request", "write"],
        shareTabs: [{ id: "tab-1", revision: 4, slug: "planning", title: "Planning" }],
        selectedShareTabId: "tab-1",
      }),
      host,
    );

    expect([...host.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Read",
      "Read + request changes",
      "Read + write",
      "Planning",
    ]);
  });

  it("shows only participants returned by the exact-tab server projection", () => {
    const host = document.createElement("div");
    render(
      renderTeamsPortal({
        status: "ready",
        route: "login",
        session: authenticatedSession(),
        tab: tabResult("read").tab,
        workspaceId: "workspace-1",
        tabId: "tab-1",
        mode: "read",
        presence: tabResult("read").presence,
        draftTitle: "Planning",
        error: null,
      }),
      host,
    );

    expect(host.querySelector('[data-teams-presence="review-agent"]')).not.toBeNull();
    expect(host.textContent).toContain("review-agent");
    expect(host.textContent).not.toContain("ada is viewing");
  });

  it("renders no dashboard navigation and hides all edit controls in read mode", () => {
    const host = document.createElement("div");
    render(
      renderTeamsPortal({
        status: "ready",
        route: "login",
        session: authenticatedSession(),
        tab: tabResult("read").tab,
        workspaceId: "workspace-1",
        tabId: "tab-1",
        mode: "read",
        draftTitle: "Planning",
        error: null,
      }),
      host,
    );

    expect(host.querySelector("openclaw-app-sidebar")).toBeNull();
    expect(host.querySelector("openclaw-settings-sidebar")).toBeNull();
    expect(host.querySelector("openclaw-command-palette")).toBeNull();
    expect(host.querySelector('[data-action="submit-draft"]')).toBeNull();
    expect(host.querySelector("textarea, input[data-teams-draft]")).toBeNull();
    expect(host.textContent).toContain("Planning");
  });

  it("redacts raw custom, file, and RPC widgets", () => {
    const host = document.createElement("div");
    render(
      renderTeamsPortal({
        status: "ready",
        route: "login",
        session: authenticatedSession(),
        tab: {
          ...tabResult("read").tab,
          widgets: [
            { id: "custom", kind: "custom", title: "Do not render" },
            { id: "file", kind: "file", title: "Also hidden" },
            { id: "rpc", kind: "rpc", title: "Never execute" },
          ],
        },
        workspaceId: "workspace-1",
        tabId: "tab-1",
        mode: "read",
        draftTitle: "Planning",
        error: null,
      }),
      host,
    );

    expect(host.textContent).toContain("Restricted content");
    expect(host.textContent).not.toContain("Do not render");
    expect(host.textContent).not.toContain("Also hidden");
    expect(host.textContent).not.toContain("Never execute");
  });
});
