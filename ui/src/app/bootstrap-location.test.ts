import { describe, expect, it, vi } from "vitest";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-key.ts";
import {
  resolveInitialApplicationLocation,
  subscribeForegroundChatBootstrap,
} from "./bootstrap-location.ts";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationContext } from "./context.ts";

describe("resolveInitialApplicationLocation", () => {
  it.each([{ sessionKey: "agent::broken", search: "?draft=hello", pathname: null }])(
    "resolves persisted '$sessionKey' without aborting bootstrap",
    async ({ sessionKey, search, pathname }) => {
      const location = { pathname: "/", search, hash: "" };
      const resolved = await resolveInitialApplicationLocation({
        location,
        basePath: "",
        sessionKey,
        gateway: {
          snapshot: { phase: "connected", client: {}, hello: null },
          subscribe: vi.fn(() => () => undefined),
        } as unknown as ApplicationContext["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      });
      expect(resolved).toEqual({ ...location, pathname: pathname ?? location.pathname });
      expect(resolved === location).toBe(pathname === null);
    },
  );

  it.each([
    { persistedSessionKey: "main", connectedSessionKey: "main" },
    { persistedSessionKey: "", connectedSessionKey: "agent:research:workspace" },
  ])(
    "waits for gateway defaults before normalizing '$persistedSessionKey'",
    async ({ persistedSessionKey, connectedSessionKey }) => {
      type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
      let listener: GatewayListener | null = null;
      let snapshot = {
        phase: "connecting",
        client: null,
        hello: null,
      } as unknown as ApplicationContext["gateway"]["snapshot"];
      const gateway = {
        get snapshot() {
          return snapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      };
      const pending = resolveInitialApplicationLocation({
        location: { pathname: "/", search: "", hash: "" },
        basePath: "",
        sessionKey: persistedSessionKey,
        gateway,
        agentsList: () => null,
        signal: new AbortController().signal,
      });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      snapshot = {
        phase: "connected",
        client: {},
        sessionKey: connectedSessionKey,
        hello: {
          snapshot: {
            sessionDefaults: { defaultAgentId: "research", mainKey: "workspace" },
          },
        },
      } as unknown as ApplicationContext["gateway"]["snapshot"];
      const connectedListener = listener as GatewayListener | null;
      if (!connectedListener) {
        throw new Error("expected gateway readiness subscription");
      }
      connectedListener(snapshot);

      await expect(pending).resolves.toEqual({
        pathname: "/chat/research",
        search: "",
        hash: "",
      });
    },
  );

  it.each(["main"])(
    "does not wait for gateway defaults on an explicit startup route with '%s'",
    async (sessionKey) => {
      const subscribe = vi.fn(() => () => undefined);
      const location = { pathname: "/settings/appearance", search: "", hash: "" };

      await expect(
        resolveInitialApplicationLocation({
          location,
          basePath: "",
          sessionKey,
          gateway: {
            snapshot: { phase: "connecting", client: null, hello: null },
            subscribe,
          } as unknown as ApplicationContext["gateway"],
          agentsList: () => null,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(location);
      expect(subscribe).not.toHaveBeenCalled();
    },
  );

  it("canonicalizes a scoped persisted main key when defaults are already known", async () => {
    const subscribe = vi.fn(() => () => undefined);

    await expect(
      resolveInitialApplicationLocation({
        location: { pathname: "/", search: "", hash: "" },
        basePath: "",
        sessionKey: "agent:research:workspace",
        gateway: {
          snapshot: {
            phase: "connected",
            client: {},
            hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
          },
          subscribe,
        } as unknown as ApplicationContext["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ pathname: "/chat/research", search: "", hash: "" });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it.each([
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Atelegram%3A12345&face=dashboard",
        hash: "",
      },
      expected: { pathname: "/dashboard/research/telegram/12345", search: "", hash: "" },
      namespace: "dashboard",
      sessionKey: "agent:research:telegram:12345",
    },
  ] as const)("rewrites released query links to $expected.pathname", async (testCase) => {
    const subscribe = vi.fn(() => () => undefined);
    const resolved = await resolveInitialApplicationLocation({
      location: testCase.location,
      basePath: "",
      sessionKey: "agent:main:main",
      gateway: {
        snapshot: { phase: "connecting", client: null, hello: null },
        subscribe,
      } as unknown as ApplicationContext["gateway"],
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
      signal: new AbortController().signal,
    });

    expect(resolved).toEqual(testCase.expected);
    expect(sessionRefFromPath(resolved.pathname, "", "main")).toMatchObject({
      namespace: testCase.namespace,
      kind: "literal",
      sessionKey: testCase.sessionKey,
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("preserves the UUID when rewriting a released session query", async () => {
    const resolved = await resolveInitialApplicationLocation({
      location: {
        pathname: "/chat",
        search:
          "?session=agent%3Aresearch%3Athread%3A12345678-aaaa-4000-8000-000000000001&draft=continue",
        hash: "",
      },
      basePath: "",
      sessionKey: "agent:main:main",
      gateway: {
        snapshot: { phase: "connected", client: {}, hello: null },
        subscribe: vi.fn(() => () => undefined),
      } as unknown as ApplicationContext["gateway"],
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
      signal: new AbortController().signal,
    });
    expect(resolved).toEqual({
      pathname: "/chat/research/12345678aaaa40008000000000000001",
      search: "?draft=continue",
      hash: "",
    });
  });

  it("does not consume Sessions list row-expansion state", async () => {
    const location = { pathname: "/sessions", search: "?session=agent%3Amain%3Amain", hash: "" };
    const subscribe = vi.fn(() => () => undefined);
    await expect(
      resolveInitialApplicationLocation({
        location,
        basePath: "",
        sessionKey: "agent:main:main",
        gateway: {
          snapshot: { phase: "connecting", client: null, hello: null },
          subscribe,
        } as unknown as ApplicationContext["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(location);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("waits for cold custom-main defaults before rewriting a released query link", async () => {
    type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    let snapshot = {
      phase: "connecting",
      client: null,
      hello: null,
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const pending = resolveInitialApplicationLocation({
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Aworkspace",
        hash: "",
      },
      basePath: "",
      sessionKey: "agent:main:main",
      gateway: {
        get snapshot() {
          return snapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agentsList: () => null,
      signal: new AbortController().signal,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    snapshot = {
      phase: "connected",
      client: {},
      hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected gateway readiness subscription");
    }
    connectedListener(snapshot);

    await expect(pending).resolves.toEqual({
      pathname: "/chat/research",
      search: "",
      hash: "",
    });
  });
});

describe("subscribeForegroundChatBootstrap", () => {
  it("re-keys a route restored before connect so the mounted pane releases background work", async () => {
    type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
    const gatewayListeners = new Set<GatewayListener>();
    const connection = { gatewayUrl: "ws://127.0.0.1:18789" };
    let snapshot = {
      phase: "connecting",
      client: null,
      hello: null,
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const gateway = {
      connection,
      get snapshot() {
        return snapshot;
      },
      subscribe: (listener: GatewayListener) => {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
    } as unknown as ApplicationContext["gateway"];
    const sessionKey = "agent:main:dashboard:restored";
    const routerState = {
      status: "idle",
      pendingMatches: [],
      matches: [{ routeId: "chat", status: "success", data: { kind: "session", sessionKey } }],
    };
    let routeListener: ((state: typeof routerState) => void) | undefined;
    const router = {
      getState: () => routerState,
      subscribe: (listener: (state: typeof routerState) => void) => {
        routeListener = listener;
        return () => undefined;
      },
    } as unknown as Parameters<typeof subscribeForegroundChatBootstrap>[0]["router"];
    const connectionBootstrap = createConnectionBootstrapCoordinator();
    const setForegroundRoute = vi.spyOn(connectionBootstrap, "setForegroundRoute");
    const stop = subscribeForegroundChatBootstrap({
      router,
      gateway,
      agents: { state: { agentsList: null } } as unknown as ApplicationContext["agents"],
      agentSelection: {
        state: { selectedId: "main" },
        subscribe: () => () => undefined,
      } as unknown as ApplicationContext["agentSelection"],
      connectionBootstrap,
      initialChatRoute: true,
      chatSubmissions: {
        creation: null,
        subscribeCreate: () => () => undefined,
      } as unknown as ApplicationContext["chatSubmissions"],
    });
    // The restored route resolves while the Gateway is still connecting.
    routeListener?.(routerState);
    const restoredKey = setForegroundRoute.mock.lastCall?.[0];
    expect(restoredKey).toMatch(/^scope:unowned:/u);

    const client = { recoveryScopeReady: true, recoveryScope: "account-1" };
    snapshot = { phase: "connected", client, hello: null } as unknown as typeof snapshot;
    for (const listener of gatewayListeners) {
      listener(snapshot);
    }
    // The chat pane keys its transcript with the connected account scope.
    const paneKey = resolveChatSnapshotKey(
      { settings: connection, client, agentsList: null, hello: null, assistantAgentId: "main" },
      { sessionKey },
    );
    expect(paneKey).not.toBe(restoredKey);
    expect(setForegroundRoute.mock.lastCall?.[0]).toBe(paneKey);

    const listSessions = vi.fn(async () => undefined);
    const discovery = connectionBootstrap.run("sessions.list", listSessions, { background: true });
    connectionBootstrap.setForegroundPane({}, { sessionKey: paneKey, client, ready: true });
    await discovery;
    expect(listSessions).toHaveBeenCalledOnce();
    stop();
  });
});
