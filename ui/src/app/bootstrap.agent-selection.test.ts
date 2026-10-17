import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentsListResult } from "../api/types.ts";
import { resolveInitialApplicationLocation } from "./bootstrap-location.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import {
  loadGatewaySessionSelection,
  loadSettings,
  saveSettings,
  setSettingsChangeListener,
} from "./settings.ts";

const hello = (defaultAgentId = "main", global = false) => ({
  snapshot: {
    sessionDefaults: {
      defaultAgentId,
      mainKey: "main",
      ...(global ? { mainSessionKey: "global", scope: "global" } : {}),
    },
  },
});
function roster(
  ids: readonly [string, ...string[]],
  defaultId = ids[0],
  scope: AgentsListResult["scope"] = "per-sender",
): AgentsListResult {
  return { defaultId, mainKey: "main", scope, agents: ids.map((id) => ({ id, kind: "agent" })) };
}
function readyGateway<T extends object>(client: T) {
  return {
    snapshot: { phase: "connected", client, hello: hello() },
    subscribe: vi.fn(() => () => undefined),
  };
}
function saveSelection(
  sessionKey: string,
  overrides: Partial<ReturnType<typeof loadSettings>> = {},
) {
  saveSettings({ ...previousSettings, sessionKey, lastActiveSessionKey: sessionKey, ...overrides });
}
function resolveLocation(
  overrides: Partial<Parameters<typeof resolveInitialApplicationLocation>[0]>,
  subscribe = vi.fn(() => () => undefined),
) {
  return resolveInitialApplicationLocation({
    location: { pathname: "/", search: "", hash: "" },
    basePath: "",
    sessionKey: "global",
    gateway: {
      snapshot: {
        phase: "connected",
        client: {},
        sessionKey: "global",
        hello: hello("dummy", true),
      },
      subscribe,
    } as unknown as ApplicationContext["gateway"],
    agentsList: () => roster(["dummy"], "dummy", "global"),
    signal: new AbortController().signal,
    ...overrides,
  });
}
let previousSettings: ReturnType<typeof loadSettings>;
let previousUrl: string;
let runtime: ReturnType<typeof bootstrapApplication> | undefined;
beforeEach(() => {
  previousSettings = loadSettings();
  previousUrl = window.location.href;
});
afterEach(() => {
  runtime?.stop();
  runtime = undefined;
  setSettingsChangeListener(null);
  window.history.replaceState({}, "", previousUrl);
  saveSettings(previousSettings);
});

it.each([
  ["openclaw", ["dummy", "openclaw"], "/chat/openclaw"],
  ["removed", ["dummy"], "/chat/dummy"],
] as const)(
  "routes a global session remembering %s through the live roster",
  async (selectedAgentId, ids, pathname) => {
    const subscribe = vi.fn(() => () => undefined);

    await expect(
      resolveLocation(
        {
          location: { pathname: "/chat", search: "", hash: "" },
          selectedAgentId,
          agentsList: () => roster(ids, "dummy", "global"),
        },
        subscribe,
      ),
    ).resolves.toEqual({ pathname, search: "", hash: "" });
    expect(subscribe).not.toHaveBeenCalled();
  },
);

it("refreshes a cached roster and its default before accepting a remembered agent", async () => {
  const cachedList = roster(["retired"]);
  const liveList = roster(["next"]);
  const ensureAgentsList = vi.fn(async () => liveList);

  await expect(
    resolveLocation({
      sessionKey: "agent:retired:main",
      gateway: readyGateway({ request: vi.fn() }) as unknown as ApplicationContext["gateway"],
      agentsList: () => cachedList,
      ensureAgentsList,
    }),
  ).resolves.toEqual({ pathname: "/chat/next", search: "", hash: "" });
  expect(ensureAgentsList).toHaveBeenCalledOnce();
});

it("validates a remembered session again after the Gateway client changes", async () => {
  const first = createDeferred<{ ok: boolean; key?: string; agentId?: string }>();
  const firstRequest = vi.fn(() => first.promise);
  const replacementRequest = vi.fn(
    async (): Promise<{ ok: boolean; key?: string; agentId?: string }> => ({ ok: false }),
  );
  const gatewayState = readyGateway({ request: firstRequest });
  const gateway = gatewayState as unknown as ApplicationContext["gateway"];
  const rememberedKey = "agent:research:thread:12345678-0000-4000-8000-000000000001";

  const pending = resolveLocation({
    location: { pathname: "/", search: "?draft=hello", hash: "" },
    sessionKey: rememberedKey,
    gateway,
    agentsList: () => roster(["main", "research"]),
  });
  await vi.waitFor(() => expect(firstRequest).toHaveBeenCalledOnce());
  gatewayState.snapshot = {
    ...gatewayState.snapshot,
    client: { request: replacementRequest },
    hello: hello(),
  };
  first.resolve({ ok: true, key: rememberedKey, agentId: "research" });

  await expect(pending).resolves.toEqual({
    pathname: "/chat/research",
    search: "?draft=hello",
    hash: "",
  });
  expect(replacementRequest).toHaveBeenCalledExactlyOnceWith(
    "sessions.resolve",
    { key: rememberedKey, agentId: "research", allowMissing: true },
    { signal: expect.any(AbortSignal) },
  );
});

it("loads the agent roster again after the Gateway client changes", async () => {
  const first = createDeferred<AgentsListResult>();
  const currentList = roster(["main"]);
  const oldList = { ...currentList, agents: [{ id: "main" }, { id: "research" }] };
  const ensureAgentsList = vi
    .fn<() => Promise<AgentsListResult>>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(currentList);
  const gatewayState = readyGateway({});
  const gateway = gatewayState as unknown as ApplicationContext["gateway"];

  const pending = resolveLocation({
    sessionKey: "agent:research:main",
    gateway,
    agentsList: () => null,
    ensureAgentsList,
  });
  await vi.waitFor(() => expect(ensureAgentsList).toHaveBeenCalledOnce());
  gatewayState.snapshot = {
    ...gatewayState.snapshot,
    client: {},
    hello: hello(),
  };
  first.resolve(oldList);

  await expect(pending).resolves.toEqual({ pathname: "/chat/main", search: "", hash: "" });
  expect(ensureAgentsList).toHaveBeenCalledTimes(2);
});

it("starts routing an agent-scoped remembered session while the Gateway is offline", async () => {
  saveSelection("agent:research:thread:12345678-0000-4000-8000-000000000001");
  window.history.replaceState({}, "", "/");
  runtime = bootstrapApplication();
  const routerStart = vi.spyOn(runtime.router, "start").mockResolvedValue(undefined);

  const start = runtime.start();
  await vi.waitFor(() => expect(routerStart).toHaveBeenCalledOnce());
  runtime.stop();
  await start;
});

it.each([
  { name: "saved target agent", selectedAgentId: "research" },
  { name: "unsaved target agent", selectedAgentId: undefined },
])("hydrates the $name during native Gateway handoff", ({ selectedAgentId }) => {
  const targetGatewayUrl = `wss://native-${selectedAgentId ?? "unset"}.example`;
  const targetSettingsKey = `openclaw.control.settings.v1:${gatewayOriginScope(targetGatewayUrl)}`;

  try {
    saveSelection("global", { gatewayUrl: targetGatewayUrl, selectedAgentId });
    saveSelection("agent:dummy:main", { selectedAgentId: "dummy" });
    window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = {
      gatewayUrl: targetGatewayUrl,
      token: "native-token",
    };
    window.history.replaceState({}, "", "/settings/appearance");

    runtime = bootstrapApplication();

    expect(runtime.context.gateway.connection.gatewayUrl).toBe(targetGatewayUrl);
    expect(runtime.context.gateway.snapshot.sessionKey).toBe("global");
    expect(loadGatewaySessionSelection(targetGatewayUrl)).toEqual({
      sessionKey: "global",
      lastActiveSessionKey: "global",
      ...(selectedAgentId ? { selectedAgentId } : {}),
    });
  } finally {
    runtime?.stop();
    delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
    localStorage.removeItem(targetSettingsKey);
  }
});

describe("initial sidebar visibility", () => {
  it.each(["/dashboard/research/conversation", "/chat/research/conversation?nav=collapsed"])(
    "starts expanded without rewriting the route at %s",
    (initialUrl) => {
      window.history.replaceState({}, "", initialUrl);
      runtime = bootstrapApplication();
      expect(runtime.context.navigation.snapshot.navCollapsed).toBe(false);
      expect(window.location.pathname + window.location.search + window.location.hash).toBe(
        initialUrl,
      );
    },
  );

  it("keeps sidebar visibility in memory without rewriting persisted settings", () => {
    const onPersistedSettingsChanged = vi.fn();
    runtime = bootstrapApplication();
    setSettingsChangeListener(onPersistedSettingsChanged);

    runtime.context.navigation.update({ navCollapsed: true });

    expect(runtime.context.navigation.snapshot.navCollapsed).toBe(true);
    expect(onPersistedSettingsChanged).not.toHaveBeenCalled();

    runtime.context.navigation.update({ navWidth: previousSettings.navWidth + 1 });

    expect(onPersistedSettingsChanged).toHaveBeenCalledOnce();
    expect(loadSettings().navWidth).toBe(previousSettings.navWidth + 1);
  });
});
