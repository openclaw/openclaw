import { createRouter } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-key.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import {
  resolveInitialApplicationLocation,
  subscribeForegroundChatBootstrap,
} from "./bootstrap-location.ts";
import { makeBootRoster, makeLocation, makeRoutingGateway } from "./bootstrap.test-support.ts";
import { createChatSubmissions } from "./chat-submissions.ts";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";

function gateway(snapshot: object) {
  return makeRoutingGateway(snapshot).gateway;
}
function resolveLocation(
  overrides: Partial<Parameters<typeof resolveInitialApplicationLocation>[0]>,
) {
  return resolveInitialApplicationLocation({
    location: makeLocation("/"),
    basePath: "",
    sessionKey: "agent:main:main",
    gateway: gateway({}),
    agentsList: () => null,
    signal: new AbortController().signal,
    ...overrides,
  });
}
async function expectPending(pending: Promise<unknown>) {
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
}

it("hydrates the roster when a literal route commits before its Gateway connects", async () => {
  const sessionKey = "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001";
  const { gateway: connection, publish } = createApplicationGateway();
  publish({ ...connection.snapshot, phase: "connecting", assistantAgentId: "main" });
  const agents = createAgentCapability(connection);
  const agentSelection = createAgentSelectionCapability(connection, agents);
  const connectionBootstrap = createConnectionBootstrapCoordinator();
  const router = createRouter<RouteId, unknown, { renderSolid: () => null }>({
    routes: [
      {
        id: "chat",
        path: "/chat/main/dashboard/12345678-aaaa-4000-8000-000000000001",
        component: () => ({ renderSolid: () => null }),
        loader: () => ({ kind: "session", sessionKey }),
      },
    ],
  });
  const stop = subscribeForegroundChatBootstrap({
    router,
    gateway: connection,
    agents,
    agentSelection,
    connectionBootstrap,
    chatSubmissions: createChatSubmissions(),
    initialChatRoute: true,
  });
  try {
    await router.navigate("chat", {});
    const hydrate = vi.fn(async () => {});
    const pending = connectionBootstrap.run("roster", hydrate, { background: true });
    expect(hydrate).not.toHaveBeenCalled();

    const client = createTestGatewayClient(async () => makeBootRoster());
    publish({ ...connection.snapshot, phase: "connected", client });
    expect(hydrate).not.toHaveBeenCalled();
    connectionBootstrap.setForegroundPane(
      {},
      {
        sessionKey: resolveChatSnapshotKey(
          { settings: connection.connection, client },
          { sessionKey },
        ),
        client,
        ready: true,
      },
    );

    expect(hydrate).toHaveBeenCalledOnce();
    await pending;
  } finally {
    stop();
    router.stop();
    connectionBootstrap.reset();
    agentSelection.dispose();
    agents.dispose();
  }
});

describe("resolveInitialApplicationLocation", () => {
  it("resolves a malformed persisted session without aborting bootstrap", async () => {
    const location = makeLocation("/", "?draft=hello");
    const resolved = await resolveLocation({ location, sessionKey: "agent::broken" });
    expect(resolved).toEqual(location);
    expect(resolved).toBe(location);
  });

  it.each([
    { persistedSessionKey: "main", connectedSessionKey: "main" },
    { persistedSessionKey: "", connectedSessionKey: "agent:research:workspace" },
  ])(
    "waits for gateway defaults before normalizing '$persistedSessionKey'",
    async ({ persistedSessionKey, connectedSessionKey }) => {
      const cold = makeRoutingGateway({ phase: "connecting", client: null });
      const pending = resolveLocation({
        sessionKey: persistedSessionKey,
        gateway: cold.gateway,
      });
      await expectPending(pending);
      expect(cold.gateway.subscribe).toHaveBeenCalledOnce();
      cold.publish({
        phase: "connected",
        client: {},
        sessionKey: connectedSessionKey,
        hello: {
          snapshot: {
            sessionDefaults: { defaultAgentId: "research", mainKey: "workspace" },
          },
        },
      });

      await expect(pending).resolves.toEqual(makeLocation("/chat/research"));
    },
  );

  it.each([
    ["/settings/appearance", "", "main"],
    ["/sessions", "?session=agent%3Amain%3Amain", "agent:main:main"],
  ])(
    "preserves explicit %s state without waiting for defaults",
    async (pathname, search, sessionKey) => {
      const cold = gateway({ phase: "connecting", client: null });
      const location = { pathname, search, hash: "" };
      await expect(resolveLocation({ location, sessionKey, gateway: cold })).resolves.toBe(
        location,
      );
      expect(cold.subscribe).not.toHaveBeenCalled();
    },
  );

  it("canonicalizes a scoped persisted main key when defaults are already known", async () => {
    const ready = gateway({ hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } } });

    await expect(
      resolveLocation({
        sessionKey: "agent:research:workspace",
        gateway: ready,
      }),
    ).resolves.toEqual(makeLocation("/chat/research"));
    expect(ready.subscribe).not.toHaveBeenCalled();
  });

  it("rewrites a released dashboard query link", async () => {
    const cold = gateway({ phase: "connecting", client: null });
    const resolved = await resolveLocation({
      location: makeLocation(
        "/chat",
        "?session=agent%3Aresearch%3Atelegram%3A12345&face=dashboard",
      ),
      gateway: cold,
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
    });

    expect(resolved).toEqual(makeLocation("/dashboard/research/telegram/12345"));
    expect(sessionRefFromPath(resolved.pathname, "", "main")).toMatchObject({
      namespace: "dashboard",
      kind: "literal",
      sessionKey: "agent:research:telegram:12345",
    });
    expect(cold.subscribe).not.toHaveBeenCalled();
  });

  it("preserves the UUID when rewriting a released session query", async () => {
    const resolved = await resolveLocation({
      location: makeLocation(
        "/chat",
        "?session=agent%3Aresearch%3Athread%3A12345678-aaaa-4000-8000-000000000001&draft=continue",
      ),
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
    });
    expect(resolved).toEqual(
      makeLocation("/chat/research/12345678aaaa40008000000000000001", "?draft=continue"),
    );
  });

  it("waits for cold custom-main defaults before rewriting a released query link", async () => {
    const cold = makeRoutingGateway({ phase: "connecting", client: null });
    const pending = resolveLocation({
      location: makeLocation("/chat", "?session=agent%3Aresearch%3Aworkspace"),
      gateway: cold.gateway,
    });
    await expectPending(pending);
    expect(cold.gateway.subscribe).toHaveBeenCalledOnce();
    cold.publish({
      phase: "connected",
      client: {},
      hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
    });

    await expect(pending).resolves.toEqual(makeLocation("/chat/research"));
  });
});
