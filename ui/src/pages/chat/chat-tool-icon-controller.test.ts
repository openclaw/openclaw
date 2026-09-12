import type { ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsEffectiveResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { ChatToolIconController } from "./chat-tool-icon-controller.ts";

const plugins: PluginListResult = {
  plugins: ["meetings", "iconless", "unused"].map((id) => ({
    id,
    name: id,
    installed: true,
    enabled: true,
    state: "enabled",
    hasIcon: id !== "iconless",
  })),
  diagnostics: [],
  mutationAllowed: false,
};
const catalog: ToolsEffectiveResult = {
  agentId: "main",
  profile: "full",
  groups: [
    {
      id: "plugin",
      label: "Tools",
      source: "plugin",
      tools: [
        { id: "meeting_status", pluginId: "meetings", source: "plugin" },
        { id: "meeting_list", pluginId: "meetings", source: "plugin" },
        { id: "other", pluginId: "iconless", source: "plugin" },
        { id: "unseen_status", pluginId: "unused", source: "plugin" },
        { id: "read", source: "core" },
      ].map((tool) =>
        Object.assign({}, tool, {
          source: tool.source as "plugin" | "core",
          label: tool.id,
          description: "",
          rawDescription: "",
        }),
      ),
    },
  ],
};

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
  const host: ReactiveControllerHost = {
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
  const fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response(new Blob(["png"]), { headers: { "content-type": "image/png" } }),
    );
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:plugin-icon");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  let session: { sessionKey: string; agentId: string } | undefined = {
    sessionKey: "agent:main:main",
    agentId: "main",
  };
  const controller = new ChatToolIconController(
    host,
    () => context,
    () => session,
  );
  return {
    controller,
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
    const { controller, setSession } = setup();
    setSession(undefined);
    controller.hostUpdate();
    const unavailable = controller.icons;
    expect(unavailable.get("meeting_status")).toBeUndefined();
    setSession("agent:main:main");
    controller.hostUpdate();
    expect(controller.icons).not.toBe(unavailable);
    await vi.waitFor(() => expect(controller.icons.get("meeting_status")).toBeDefined());
    controller.hostDisconnected();
  });

  it("recovers a failed plugin-list read when another tool needs ownership", async () => {
    const { controller, request, fetch } = setup();
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
    controller.hostUpdate();
    controller.icons.get("meeting_status");
    await vi.waitFor(() => expect(pluginRequests).toBe(1));
    expect(controller.icons.get("meeting_status")).toBeUndefined();
    await vi.waitFor(() => expect(controller.icons.get("meeting_list")).toBeDefined());
    expect(controller.icons.get("meeting_status")).toBeDefined();
    expect(pluginRequests).toBe(2);
    expect(fetch).toHaveBeenCalledOnce();
    controller.hostDisconnected();
  });

  it("discovers newly visible tools in the same session without downloading their cached icon again", async () => {
    const { controller, request, fetch } = setup();
    controller.hostUpdate();
    await vi.waitFor(() => expect(controller.icons.get("meeting_status")).toBeDefined());
    request.mockImplementation(async (method) =>
      method === "plugins.list"
        ? plugins
        : {
            ...catalog,
            groups: catalog.groups.map((group) =>
              Object.assign({}, group, {
                tools: [
                  ...group.tools,
                  ...["meeting_join", "meeting_leave"].map((id) => ({
                    id,
                    label: id,
                    description: "",
                    rawDescription: "",
                    source: "plugin",
                    pluginId: "meetings",
                  })),
                ],
              }),
            ),
          },
    );
    const previous = controller.icons;
    expect(controller.icons.get("meeting_join")).toBeUndefined();
    expect(controller.icons.get("meeting_leave")).toBeUndefined();
    expect(controller.icons.get("unavailable")).toBeUndefined();
    await vi.waitFor(() => expect(controller.icons.get("meeting_join")).toBeDefined());
    expect(controller.icons.get("meeting_leave")?.url).toBe(
      controller.icons.get("meeting_status")?.url,
    );
    expect(controller.icons).not.toBe(previous);
    expect(controller.icons.get("unavailable")).toBeUndefined();
    await Promise.resolve();
    expect(request.mock.calls.filter(([method]) => method === "tools.effective")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
    controller.hostDisconnected();
  });

  it("shares an icon only across tools owned by its plugin and keeps failed images on the fallback", async () => {
    const { controller, request, fetch, revoke } = setup();
    controller.hostUpdate();
    expect(request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(controller.icons.get("meeting_status")).toBeDefined());
    expect(controller.icons.get("meeting_list")?.url).toBe(
      controller.icons.get("meeting_status")?.url,
    );
    expect(controller.icons.get("read")).toBeUndefined();
    expect(controller.icons.get("other")).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toContain("meetings");
    controller.hostUpdate();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    const previous = controller.icons;
    controller.icons.get("meeting_status")?.onError();
    expect(controller.icons.get("meeting_status")).toBeUndefined();
    expect(controller.icons).not.toBe(previous);
    expect(revoke).toHaveBeenCalledWith("blob:plugin-icon");
    controller.hostDisconnected();
  });

  it.each(["session", "agent"])(
    "ignores retired %s ownership and releases images when the connection leaves",
    async (change) => {
      const { controller, request, context, setSession, fetch, revoke } = setup();
      if (change === "agent") {
        setSession("global", "first");
      }
      const pending = createDeferred<ToolsEffectiveResult>();
      request.mockImplementationOnce(() => pending.promise);
      controller.hostUpdate();
      controller.icons.get("meeting_status");
      await Promise.resolve();
      setSession(change === "agent" ? "global" : "second", "second");
      controller.hostUpdate();
      await vi.waitFor(() => expect(controller.icons.get("meeting_status")).toBeDefined());
      pending.resolve({
        ...catalog,
        groups: [
          {
            ...catalog.groups[0]!,
            tools: [{ ...catalog.groups[0]!.tools[0]!, id: "retired_tool" }],
          },
        ],
      });
      await pending.promise;
      await Promise.resolve();
      expect(controller.icons.get("retired_tool")).toBeUndefined();
      expect(fetch).toHaveBeenCalledOnce();
      context.gateway.snapshot.phase = "offline";
      controller.hostUpdate();
      expect(controller.icons.get("meeting_status")).toBeUndefined();
      expect(revoke).toHaveBeenCalledWith("blob:plugin-icon");
    },
  );

  it("retires icons and pending ownership when the same client changes credentials", async () => {
    const { controller, context, request, revoke } = setup();
    controller.hostUpdate();
    await vi.waitFor(() => expect(controller.icons.get("meeting_status")).toBeDefined());
    const pending = createDeferred<ToolsEffectiveResult>();
    request.mockImplementationOnce(() => pending.promise);
    context.gateway.connectionRevision++;
    controller.hostUpdate();
    expect(controller.icons.get("meeting_status")).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith("blob:plugin-icon");
    await Promise.resolve();
    context.gateway.connectionRevision++;
    pending.resolve(catalog);
    await pending.promise;
    await Promise.resolve();
    expect(controller.icons.get("meeting_status")).toBeUndefined();
    controller.hostUpdate();
    await vi.waitFor(() => expect(controller.icons.get("meeting_status")).toBeDefined());
    controller.hostDisconnected();
  });

  it.each(["plugin", "mcp"] as const)(
    "uses effective %s ownership even for a tool in the static core catalog",
    async (source) => {
      const { controller, request } = setup();
      request.mockImplementationOnce(async () => ({
        ...catalog,
        groups: [
          {
            ...catalog.groups[0]!,
            tools: [{ ...catalog.groups[0]!.tools[0]!, id: "browser", source }],
          },
        ],
      }));
      controller.hostUpdate();
      await vi.waitFor(() => expect(controller.icons.get("browser")).toBeDefined());
      expect(request).toHaveBeenCalledWith(
        "tools.effective",
        { sessionKey: "agent:main:main", agentId: "main" },
        expect.anything(),
      );
      controller.hostDisconnected();
    },
  );

  it("discards an icon response that finishes after the pane disconnects", async () => {
    const { controller, fetch, revoke } = setup();
    const response = createDeferred<Response>();
    fetch.mockReturnValueOnce(response.promise);
    controller.hostUpdate();
    controller.icons.get("meeting_status");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.hostDisconnected();
    response.resolve(new Response(new Blob(["png"]), { headers: { "content-type": "image/png" } }));
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:plugin-icon"));
    expect(controller.icons.get("meeting_status")).toBeUndefined();
  });
  it("ignores a removed image's late error after its owner has been replaced", async () => {
    const { controller, context, revoke, fetch } = setup();
    controller.hostUpdate();
    await vi.waitFor(() => expect(controller.icons.get("meeting_status")).toBeDefined());
    const oldIcon = controller.icons.get("meeting_status");
    context.gateway.connectionRevision++;
    controller.hostUpdate();
    await vi.waitFor(() => expect(controller.icons.get("meeting_status")).toBeDefined());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledOnce();
    oldIcon?.onError();
    expect(controller.icons.get("meeting_status")).toBeDefined();
    expect(revoke).toHaveBeenCalledOnce();
    controller.hostDisconnected();
  });
});
