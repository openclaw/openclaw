import { describe, expect, it, vi } from "vitest";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { resolveInitialApplicationLocation } from "./bootstrap-location.ts";
import type { ApplicationContext } from "./context.ts";

type Gateway = ApplicationContext["gateway"];
function gateway(snapshot: object) {
  return {
    snapshot: { phase: "connected", client: {}, hello: null, ...snapshot },
    subscribe: vi.fn(() => () => undefined),
  } as unknown as Gateway;
}
function resolveLocation(
  overrides: Partial<Parameters<typeof resolveInitialApplicationLocation>[0]>,
) {
  return resolveInitialApplicationLocation({
    location: { pathname: "/", search: "", hash: "" },
    basePath: "",
    sessionKey: "agent:main:main",
    gateway: gateway({}),
    agentsList: () => null,
    signal: new AbortController().signal,
    ...overrides,
  });
}
function coldGateway() {
  type Listener = Parameters<Gateway["subscribe"]>[0];
  let listener: Listener | undefined;
  const cold = gateway({ phase: "connecting", client: null });
  cold.subscribe = (next) => {
    listener = next;
    return () => undefined;
  };
  return {
    gateway: cold,
    connect(snapshot: object) {
      Object.assign(cold.snapshot, { phase: "connected", client: {}, ...snapshot });
      if (!listener) {
        throw new Error("expected gateway readiness subscription");
      }
      listener(cold.snapshot);
    },
  };
}
async function expectPending(pending: Promise<unknown>) {
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
}

describe("resolveInitialApplicationLocation", () => {
  it("resolves a malformed persisted session without aborting bootstrap", async () => {
    const location = { pathname: "/", search: "?draft=hello", hash: "" };
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
      const cold = coldGateway();
      const pending = resolveLocation({
        sessionKey: persistedSessionKey,
        gateway: cold.gateway,
      });
      await expectPending(pending);
      cold.connect({
        sessionKey: connectedSessionKey,
        hello: {
          snapshot: {
            sessionDefaults: { defaultAgentId: "research", mainKey: "workspace" },
          },
        },
      });

      await expect(pending).resolves.toEqual({
        pathname: "/chat/research",
        search: "",
        hash: "",
      });
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
    ).resolves.toEqual({ pathname: "/chat/research", search: "", hash: "" });
    expect(ready.subscribe).not.toHaveBeenCalled();
  });

  it("rewrites a released dashboard query link", async () => {
    const cold = gateway({ phase: "connecting", client: null });
    const resolved = await resolveLocation({
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Atelegram%3A12345&face=dashboard",
        hash: "",
      },
      gateway: cold,
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
    });

    expect(resolved).toEqual({
      pathname: "/dashboard/research/telegram/12345",
      search: "",
      hash: "",
    });
    expect(sessionRefFromPath(resolved.pathname, "", "main")).toMatchObject({
      namespace: "dashboard",
      kind: "literal",
      sessionKey: "agent:research:telegram:12345",
    });
    expect(cold.subscribe).not.toHaveBeenCalled();
  });

  it("preserves the UUID when rewriting a released session query", async () => {
    const resolved = await resolveLocation({
      location: {
        pathname: "/chat",
        search:
          "?session=agent%3Aresearch%3Athread%3A12345678-aaaa-4000-8000-000000000001&draft=continue",
        hash: "",
      },
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
    });
    expect(resolved).toEqual({
      pathname: "/chat/research/12345678aaaa40008000000000000001",
      search: "?draft=continue",
      hash: "",
    });
  });

  it("waits for cold custom-main defaults before rewriting a released query link", async () => {
    const cold = coldGateway();
    const pending = resolveLocation({
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Aworkspace",
        hash: "",
      },
      gateway: cold.gateway,
    });
    await expectPending(pending);
    cold.connect({
      hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
    });

    await expect(pending).resolves.toEqual({
      pathname: "/chat/research",
      search: "",
      hash: "",
    });
  });
});
