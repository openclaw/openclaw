import { createRoot, createSignal, flush, untrack } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import * as iconLoader from "../plugins/icon-loader.ts";
import { createChatToolIcons } from "./chat-tool-icon-controller.ts";

const installed = { installed: true, enabled: true, state: "enabled" as const, hasIcon: true };
const entries = ["meetings", "iconless", "unused"].map((id) =>
  Object.assign({}, installed, { id, name: id, hasActivityIcon: id !== "iconless" }),
);
const plugins: PluginListResult = { plugins: entries, diagnostics: [], mutationAllowed: false };
type Tool = ToolsEffectiveResult["groups"][number]["tools"][number];
function tool(id: string, pluginId?: string): Tool {
  const source = pluginId ? "plugin" : "core";
  return { id, pluginId, source, label: id, description: "", rawDescription: "" };
}
function withTools(tools: Tool[]): ToolsEffectiveResult {
  const group = { id: "plugin", label: "Tools", source: "plugin" as const, tools };
  return { agentId: "main", profile: "full", groups: [group] };
}
const catalog = withTools([
  ...["meeting_status", "meeting_list"].map((name) => tool(name, "meetings")),
  tool("other", "iconless"),
  tool("unseen_status", "unused"),
  tool("read"),
]);
function respond(method: string, tools = catalog, available = plugins) {
  if (method !== "plugins.list" && method !== "tools.effective") {
    throw new Error(`Unexpected request: ${method}`);
  }
  return method === "plugins.list" ? available : tools;
}
const startingSession = { sessionKey: "agent:main:main", agentId: "main" };

function setup() {
  const gatewayUrl = window.location.origin.replace(/^http/u, "ws");
  const client = new GatewayBrowserClient({ url: gatewayUrl });
  const request = vi.spyOn(client, "request").mockImplementation(async (method) => respond(method));
  const snapshot: ApplicationGatewaySnapshot = {
    ...createApplicationGateway().gateway.snapshot,
    client,
    phase: "connected",
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
  };
  const connection = { gatewayUrl, token: "", password: "", bootstrapToken: "" };
  const gateway = { snapshot, connectionRevision: 1, connection };
  const context = { resourceBasePath: "", gateway };
  const fetch = vi.spyOn(iconLoader, "fetchPluginActivityIconBlobUrl");
  fetch.mockResolvedValue("blob:plugin-icon");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  let session: typeof startingSession | undefined = startingSession;
  const controls = createRoot((dispose) => {
    const [revision, setRevision] = createSignal(0);
    const icons = createChatToolIcons(() => {
      revision();
      return { context, session };
    });
    return {
      icon: (name: string) => untrack(() => icons.get(name)),
      update: () => {
        setRevision((value) => value + 1);
        flush();
      },
      dispose,
    };
  });
  flush();
  onTestFinished(controls.dispose);
  const setSession = (sessionKey: string | undefined, agentId = "main") => {
    session = sessionKey ? { sessionKey, agentId } : undefined;
  };
  return { ...controls, context, request, fetch, revoke, setSession };
}

afterEach(() => vi.restoreAllMocks());
it("invalidates rendered fallbacks when the session identity first becomes available", async () => {
  const { icon, update, setSession } = setup();
  setSession(undefined);
  update();
  expect(icon("meeting_status")).toBeUndefined();
  setSession("agent:main:main");
  update();
  await vi.waitFor(() => expect(icon("meeting_status")).toBeDefined());
});

it("recovers a failed plugin-list read when another tool needs ownership", async () => {
  const { icon, update, request, fetch } = setup();
  let pluginRequests = 0;
  request.mockImplementation(async (method) => {
    if (method === "plugins.list" && ++pluginRequests === 1) {
      throw new Error("temporary metadata failure");
    }
    return respond(method);
  });
  update();
  icon("meeting_status");
  await vi.waitFor(() => expect(pluginRequests).toBe(1));
  expect(icon("meeting_status")).toBeUndefined();
  await vi.waitFor(() => expect(icon("meeting_list")).toBeDefined());
  expect(icon("meeting_status")).toBeDefined();
  expect(pluginRequests).toBe(2);
  expect(fetch).toHaveBeenCalledOnce();
});

it("discovers newly visible tools in the same session without downloading their cached icon again", async () => {
  const { icon, update, request, fetch } = setup();
  update();
  await vi.waitFor(() => expect(icon("meeting_status")).toBeDefined());
  request.mockImplementation(async (method) =>
    respond(
      method,
      withTools([
        ...catalog.groups[0]!.tools,
        ...["meeting_join", "meeting_leave"].map((id) => tool(id, "meetings")),
      ]),
    ),
  );
  expect([icon("meeting_join"), icon("meeting_leave"), icon("unavailable")]).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  await vi.waitFor(() => expect(icon("meeting_join")).toBeDefined());
  expect(icon("meeting_leave")?.url).toBe(icon("meeting_status")?.url);
  expect(icon("unavailable")).toBeUndefined();
  await Promise.resolve();
  expect(request.mock.calls.filter(([method]) => method === "tools.effective")).toHaveLength(2);
  expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(1);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([true, false])("shares artwork or preserves neutral fallbacks: %s", async (available) => {
  const { icon, update, request, fetch, revoke } = setup();
  if (!available) {
    fetch.mockResolvedValue(null);
  }
  update();
  expect([request.mock.calls.length, fetch.mock.calls.length]).toEqual([0, 0]);
  if (available) {
    await vi.waitFor(() => expect(icon("meeting_status")).toBeDefined());
  } else {
    icon("meeting_status");
    icon("other");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await Promise.resolve();
  }
  const url = available ? "blob:plugin-icon" : undefined;
  expect([icon("meeting_status")?.url, icon("meeting_list")?.url]).toEqual([url, url]);
  expect([icon("read"), icon("other")]).toEqual([undefined, undefined]);
  expect(fetch).toHaveBeenCalledOnce();
  if (!available) {
    expect([icon("meeting_status"), icon("meeting_list")]).toEqual([undefined, undefined]);
    return;
  }
  expect(fetch.mock.calls[0]?.[0]).toMatchObject({ pluginId: "meetings", tool: undefined });
  update();
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
  icon("meeting_status")?.onError();
  flush();
  expect(icon("meeting_status")).toBeUndefined();
  expect(revoke).toHaveBeenCalledWith("blob:plugin-icon");
});

it("uses exact per-tool overrides with default artwork available", async () => {
  const { icon, update, request, fetch } = setup();
  const names = ["mcp__meetings__browser", "mcp__meetings__list", "mcp__meetings__cancel"];
  request.mockImplementation(async (method) =>
    respond(method, withTools(names.map((id) => tool(id, "meetings"))), {
      ...plugins,
      plugins: [{ ...plugins.plugins[0]!, activityIconTools: [names[2]!, "browser"] }],
    }),
  );
  fetch.mockImplementation(async ({ tool: override }) =>
    override ? "blob:cancel-glyph" : "blob:default-glyph",
  );
  update();
  for (const name of names) {
    icon(name);
  }
  await vi.waitFor(() => expect(icon(names[2]!)?.url).toBe("blob:cancel-glyph"));
  expect([icon(names[0]!)?.url, icon(names[1]!)?.url]).toEqual([
    "blob:default-glyph",
    "blob:default-glyph",
  ]);
  expect(fetch.mock.calls.map(([params]) => [params.pluginId, params.tool])).toEqual([
    ["meetings", undefined],
    ["meetings", names[2]],
  ]);
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["session", "agent"])(
  "retires %s ownership and releases images offline",
  async (change) => {
    const { icon, update, request, context, setSession, fetch, revoke } = setup();
    if (change === "agent") {
      setSession("global", "first");
    }
    const pending = createDeferred<ToolsEffectiveResult>();
    request.mockImplementationOnce(() => pending.promise);
    update();
    icon("meeting_status");
    await Promise.resolve();
    setSession(change === "agent" ? "global" : "second", "second");
    update();
    await vi.waitFor(() => expect(icon("meeting_status")).toBeDefined());
    pending.resolve(withTools([tool("retired_tool", "meetings")]));
    await pending.promise;
    await Promise.resolve();
    expect(icon("retired_tool")).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    context.gateway.snapshot.phase = "offline";
    update();
    expect(icon("meeting_status")).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith("blob:plugin-icon");
  },
);

it("retires icons and pending ownership when the same client changes credentials", async () => {
  const { icon, update, context, request, revoke } = setup();
  update();
  await vi.waitFor(() => expect(icon("meeting_status")).toBeDefined());
  const pending = createDeferred<ToolsEffectiveResult>();
  request.mockImplementationOnce(() => pending.promise);
  context.gateway.connectionRevision++;
  update();
  expect(icon("meeting_status")).toBeUndefined();
  expect(revoke).toHaveBeenCalledWith("blob:plugin-icon");
  await Promise.resolve();
  context.gateway.connectionRevision++;
  pending.resolve(catalog);
  await pending.promise;
  await Promise.resolve();
  expect(icon("meeting_status")).toBeUndefined();
  update();
  await vi.waitFor(() => expect(icon("meeting_status")).toBeDefined());
});

it("discards an icon response that finishes after the pane disconnects", async () => {
  const { icon, update, dispose, fetch, revoke } = setup();
  const response = createDeferred<string | null>();
  fetch.mockReturnValueOnce(response.promise);
  update();
  icon("meeting_status");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  dispose();
  response.resolve("blob:plugin-icon");
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:plugin-icon"));
  expect(icon("meeting_status")).toBeUndefined();
});
