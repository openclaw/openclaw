import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentsListResult } from "../api/types.ts";
import { resolveInitialApplicationLocation } from "./bootstrap-location.ts";
import { makeLocation, makeRoutingGateway } from "./bootstrap.test-support.ts";
import { bootstrapApplication } from "./bootstrap.ts";
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
function readyGateway(client: object) {
  return makeRoutingGateway({ client, hello: hello() });
}
function saveSelection(
  sessionKey: string,
  overrides: Partial<ReturnType<typeof loadSettings>> = {},
) {
  saveSettings({ ...previousSettings, sessionKey, lastActiveSessionKey: sessionKey, ...overrides });
}
function resolveLocation(
  overrides: Partial<Parameters<typeof resolveInitialApplicationLocation>[0]>,
) {
  return resolveInitialApplicationLocation({
    location: makeLocation("/"),
    basePath: "",
    sessionKey: "global",
    gateway: makeRoutingGateway({ sessionKey: "global", hello: hello("dummy", true) }).gateway,
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
  ["global", "openclaw", ["dummy", "openclaw"], false, "/chat/openclaw"],
  ["global", "removed", ["dummy"], false, "/chat/dummy"],
  ["global", "openclaw", ["dummy", "openclaw"], true, "/chat/openclaw"],
  ["workspace", "openclaw", ["dummy", "openclaw"], true, "/chat/openclaw/workspace"],
] as const)(
  "restores %s remembering %s from roster %j (cold: %s)",
  async (sessionKey, selectedAgentId, ids, cold, pathname) => {
    const liveList = roster(ids, "dummy", "global");
    await expect(
      resolveLocation({
        location: makeLocation("/chat"),
        sessionKey,
        selectedAgentId,
        agentsList: () => (cold ? null : liveList),
        ...(cold ? { ensureAgentsList: async () => liveList } : {}),
      }),
    ).resolves.toEqual(makeLocation(pathname));
  },
);

it("refreshes a cached roster and its default before accepting a remembered agent", async () => {
  await expect(
    resolveLocation({
      sessionKey: "agent:retired:main",
      gateway: readyGateway({ request: vi.fn() }).gateway,
      agentsList: () => roster(["retired"]),
      ensureAgentsList: async () => roster(["next"]),
    }),
  ).resolves.toEqual(makeLocation("/chat/next"));
});

it("validates a remembered session again after the Gateway client changes", async () => {
  const first = createDeferred<{ ok: boolean; key?: string; agentId?: string }>();
  const firstRequest = vi.fn(() => first.promise);
  const replacementRequest = vi.fn(
    async (): Promise<{ ok: boolean; key?: string; agentId?: string }> => ({ ok: false }),
  );
  const gatewayState = readyGateway({ request: firstRequest });
  const rememberedKey = "agent:research:thread:12345678-0000-4000-8000-000000000001";

  const pending = resolveLocation({
    location: makeLocation("/", "?draft=hello"),
    sessionKey: rememberedKey,
    gateway: gatewayState.gateway,
    agentsList: () => roster(["main", "research"]),
  });
  await vi.waitFor(() => expect(firstRequest).toHaveBeenCalledOnce());
  gatewayState.publish({ client: { request: replacementRequest }, hello: hello() });
  first.resolve({ ok: true, key: rememberedKey, agentId: "research" });

  await expect(pending).resolves.toEqual(makeLocation("/chat/research", "?draft=hello"));
});

it("loads the agent roster again after the Gateway client changes", async () => {
  const first = createDeferred<AgentsListResult>();
  const currentList = roster(["main"]);
  const ensureAgentsList = vi
    .fn<() => Promise<AgentsListResult>>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(currentList);
  const gatewayState = readyGateway({});

  const pending = resolveLocation({
    sessionKey: "agent:research:main",
    gateway: gatewayState.gateway,
    agentsList: () => null,
    ensureAgentsList,
  });
  await vi.waitFor(() => expect(ensureAgentsList).toHaveBeenCalledOnce());
  gatewayState.publish({ client: {}, hello: hello() });
  first.resolve(roster(["main", "research"]));

  await expect(pending).resolves.toEqual(makeLocation("/chat/main"));
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
