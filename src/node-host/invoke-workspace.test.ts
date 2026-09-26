import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandContext,
} from "../plugins/types.node-host.js";
import { createDeferredCore } from "../shared/deferred.js";
import { handleInvoke } from "./invoke.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("node workspace invocation ownership", () => {
  it("binds managed workspace claims to the exact live plugin invocation session", async () => {
    const release = vi.fn();
    const acquireManagedWorkspace = vi.fn(() => ({ workspaceDir: "/managed", release }));
    const workspaceRequest = {
      workspaceDir: "/managed",
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 1,
      sessionKey: "agent:main:managed",
    };
    let retainedAcquire:
      | NonNullable<OpenClawPluginNodeHostCommandContext["acquireManagedWorkspace"]>
      | undefined;
    const handle = vi.fn<OpenClawPluginNodeHostCommand["handle"]>(
      async (paramsJSON, _io, context) => {
        expect(JSON.parse(paramsJSON ?? "{}")).toEqual({ sessionKey: "agent:main:other" });
        expect(context?.sessionKey).toBe(workspaceRequest.sessionKey);
        const acquire = context?.acquireManagedWorkspace;
        if (!acquire) {
          throw new Error("managed workspace authority missing");
        }
        retainedAcquire = acquire;
        expect(() => acquire({ ...workspaceRequest, sessionKey: "agent:main:other" })).toThrow(
          "workspace invocation authority is closed",
        );
        expect(acquire(workspaceRequest)).toEqual({
          workspaceDir: "/managed",
          release,
        });
        return '{"ok":true}';
      },
    );
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "workspace-plugin",
        pluginName: "Workspace Plugin",
        command: { command: "workspace.claim", handle },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);

    await handleInvoke(
      {
        id: "invoke-workspace",
        nodeId: "node-1",
        command: "workspace.claim",
        paramsJSON: JSON.stringify({ sessionKey: "agent:main:other" }),
        sessionKey: workspaceRequest.sessionKey,
      },
      { request } as unknown as GatewayClient,
      { current: async () => [] },
      undefined,
      { pluginCommandContext: { sendNodeEvent: vi.fn(), acquireManagedWorkspace } },
    );

    expect(acquireManagedWorkspace).toHaveBeenCalledOnce();
    expect(() => retainedAcquire?.(workspaceRequest)).toThrow(
      "workspace invocation authority is closed",
    );
  });

  it.each(["current", "aborted", "returned"] as const)(
    "settles an async workspace acquisition when its plugin invocation is %s",
    async (outcome) => {
      const controller = new AbortController();
      const release = vi.fn();
      const lease = { workspaceDir: "/managed", release };
      const pending = createDeferredCore<typeof lease>();
      const entered = createDeferredCore();
      const workspaceRequest = {
        workspaceDir: "/managed",
        environmentId: "environment-1",
        sessionId: "session-1",
        ownerEpoch: 1,
        sessionKey: "agent:main:managed",
      };
      const acquireManagedWorkspaceAsync = vi.fn(() => pending.promise);
      let acquisition:
        | Promise<
            Awaited<
              ReturnType<
                NonNullable<OpenClawPluginNodeHostCommandContext["acquireManagedWorkspaceAsync"]>
              >
            >
          >
        | undefined;
      let retainedAcquire: OpenClawPluginNodeHostCommandContext["acquireManagedWorkspaceAsync"];
      const registry = createEmptyPluginRegistry();
      registry.nodeHostCommands = [
        {
          pluginId: "workspace-plugin",
          pluginName: "Workspace Plugin",
          source: "test",
          command: {
            command: "workspace.claim",
            handle: async (_params, _io, context) => {
              const acquire = context?.acquireManagedWorkspaceAsync;
              if (!acquire) {
                throw new Error("managed workspace authority missing");
              }
              retainedAcquire = acquire;
              await expect(
                acquire({ ...workspaceRequest, sessionKey: "agent:main:other" }),
              ).rejects.toThrow("workspace invocation authority is closed");
              acquisition = acquire(workspaceRequest);
              void acquisition.catch(() => {});
              entered.resolve();
              if (outcome !== "returned") {
                await acquisition;
              }
              return '{"ok":true}';
            },
          },
        },
      ];
      setActivePluginRegistry(registry);
      const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
      const invocation = handleInvoke(
        {
          id: "invoke-workspace-async",
          nodeId: "node-1",
          command: "workspace.claim",
          sessionKey: workspaceRequest.sessionKey,
        },
        { request } as unknown as GatewayClient,
        { current: async () => [] },
        undefined,
        {
          signal: controller.signal,
          pluginCommandContext: { sendNodeEvent: vi.fn(), acquireManagedWorkspaceAsync },
        },
      );
      await entered.promise;
      expect(release).not.toHaveBeenCalled();
      if (outcome === "aborted") {
        controller.abort(new Error("invocation cancelled"));
      }
      if (outcome === "returned") {
        await invocation;
      }
      pending.resolve(lease);
      if (outcome === "current") {
        await expect(acquisition).resolves.toBe(lease);
      } else {
        await expect(acquisition).rejects.toThrow("workspace invocation authority is closed");
      }
      await invocation;
      expect(release).toHaveBeenCalledTimes(outcome === "current" ? 0 : 1);
      expect(acquireManagedWorkspaceAsync).toHaveBeenCalledExactlyOnceWith(workspaceRequest);
      await expect(retainedAcquire!(workspaceRequest)).rejects.toThrow(
        "workspace invocation authority is closed",
      );
    },
  );
});
