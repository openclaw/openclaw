import { createRoot, createSignal, flush, untrack } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import * as iconLoader from "../plugins/icon-loader.ts";
import { createChatToolIcons } from "./chat-tool-icon-controller.ts";

const plugins: PluginListResult = {
  plugins: ["meetings", "iconless", "unused"].map((id) => ({
    id,
    name: id,
    installed: true,
    enabled: true,
    state: "enabled",
    hasIcon: true,
    hasActivityIcon: id !== "iconless",
  })),
  diagnostics: [],
  mutationAllowed: false,
};
function tool(
  id: string,
  pluginId?: string,
): ToolsEffectiveResult["groups"][number]["tools"][number] {
  return {
    id,
    pluginId,
    source: pluginId ? "plugin" : "core",
    label: id,
    description: "",
    rawDescription: "",
  };
}
const catalog: ToolsEffectiveResult = {
  agentId: "main",
  profile: "full",
  groups: [
    {
      id: "plugin",
      label: "Tools",
      source: "plugin",
      tools: [
        tool("meeting_status", "meetings"),
        tool("meeting_list", "meetings"),
        tool("other", "iconless"),
        tool("unseen_status", "unused"),
        tool("read"),
      ],
    },
  ],
};
const withTools = (
  tools: ToolsEffectiveResult["groups"][number]["tools"],
): ToolsEffectiveResult => ({ ...catalog, groups: [{ ...catalog.groups[0]!, tools }] });

function setup() {
  const client = new GatewayBrowserClient({ url: window.location.origin.replace(/^http/u, "ws") });
  const request = vi.spyOn(client, "request").mockImplementation(async (method) => {
    if (method === "plugins.list") {
      return plugins;
    }
    if (method === "tools.effective") {
      return catalog;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const context = {
    resourceBasePath: "",
    gateway: {
      snapshot,
      connectionRevision: 1,
      connection: {
        gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
        token: "",
        password: "",
        bootstrapToken: "",
      },
    },
  };
  const fetch = vi
    .spyOn(iconLoader, "fetchPluginActivityIconBlobUrl")
    .mockResolvedValue("blob:plugin-icon");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  let session: { sessionKey: string; agentId: string } | undefined = {
    sessionKey: "agent:main:main",
    agentId: "main",
  };
  const { icons, notify, dispose } = createRoot((disposeRoot) => {
    const [revision, setRevision] = createSignal(0);
    return {
      icons: createChatToolIcons(() => {
        revision();
        return { context, session };
      }),
      notify: () => setRevision((value) => value + 1),
      dispose: disposeRoot,
    };
  });
  const update = () => {
    notify();
    flush();
  };
  flush();
  onTestFinished(dispose);
  return {
    icon: (name: string) => untrack(() => icons.get(name)),
    update,
    dispose,
    context,
    request,
    fetch,
    revoke,
    setSession: (sessionKey: string | undefined, agentId = "main") => {
      session = sessionKey ? { sessionKey, agentId } : undefined;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat tool icon ownership", () => {
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
      if (method !== "plugins.list") {
        return catalog;
      }
      if (++pluginRequests === 1) {
        throw new Error("temporary metadata failure");
      }
      return plugins;
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
      method === "plugins.list"
        ? plugins
        : withTools([
            ...catalog.groups[0]!.tools,
            ...["meeting_join", "meeting_leave"].map((id) => tool(id, "meetings")),
          ]),
    );
    expect(icon("meeting_join")).toBeUndefined();
    expect(icon("meeting_leave")).toBeUndefined();
    expect(icon("unavailable")).toBeUndefined();
    await vi.waitFor(() => expect(icon("meeting_join")).toBeDefined());
    expect(icon("meeting_leave")?.url).toBe(icon("meeting_status")?.url);
    expect(icon("unavailable")).toBeUndefined();
    await Promise.resolve();
    expect(request.mock.calls.filter(([method]) => method === "tools.effective")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("shares an icon only across tools owned by its plugin and keeps failed images on the fallback", async () => {
    const { icon, update, request, fetch, revoke } = setup();
    update();
    expect(request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(icon("meeting_status")).toBeDefined());
    expect(icon("meeting_list")?.url).toBe(icon("meeting_status")?.url);
    expect(icon("read")).toBeUndefined();
    expect(icon("other")).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
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
      method === "plugins.list"
        ? {
            ...plugins,
            plugins: plugins.plugins.map((plugin) =>
              Object.assign({}, plugin, {
                hasActivityIcon: true,
                activityIconTools: [names[2]!, "browser"],
              }),
            ),
          }
        : withTools(names.map((id) => tool(id, "meetings"))),
    );
    fetch.mockImplementation(async ({ tool: override }) =>
      override ? "blob:cancel-glyph" : "blob:default-glyph",
    );
    update();
    for (const name of names) {
      icon(name);
    }
    await vi.waitFor(() => expect(icon(names[2]!)?.url).toBe("blob:cancel-glyph"));
    expect(icon(names[0]!)?.url).toBe("blob:default-glyph");
    expect(icon(names[1]!)?.url).toBe("blob:default-glyph");
    expect(fetch.mock.calls.map(([params]) => [params.pluginId, params.tool])).toEqual([
      ["meetings", undefined],
      ["meetings", names[2]],
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps unavailable activity artwork on the neutral fallback without fetching the package logo", async () => {
    const { icon, update, fetch } = setup();
    fetch.mockResolvedValue(null);
    update();
    icon("meeting_status");
    icon("other");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(icon("meeting_status")).toBeUndefined();
    expect(icon("meeting_list")).toBeUndefined();
    expect(icon("other")).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["session", "agent"])(
    "ignores retired %s ownership and releases images when the connection leaves",
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
});
