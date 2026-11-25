import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayClient } from "../gateway/client.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandContext,
} from "../plugins/types.node-host.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withNodeHostPluginInvocation } from "./invoke-plugin-context.js";
import { handleInvoke } from "./invoke.js";
import {
  captureNodeWorkerManagedIdentityTransport,
  captureNodeWorkerPlatformTrust,
} from "./node-worker-environment.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("node workspace invocation ownership", () => {
  it.each([
    { ending: "settled", dedicated: true },
    { ending: "settled", dedicated: false },
    ...["aborted", "released", "retired"].map((ending) => ({ ending, dedicated: true })),
  ])("fences $ending plugin custody with dedicated=$dedicated", async ({ ending, dedicated }) => {
    const root = await fs.realpath(tempDirs.make("node-managed-process-env-"));
    const header = "synthetic-invocation-provider-header";
    const transport = {
      IDENTITY_ENDPOINT: "http://127.0.0.1:40342/identity",
      IDENTITY_HEADER: header,
    };
    const platformTrust = captureNodeWorkerPlatformTrust({
      REQUESTS_CA_BUNDLE: "/trusted/requests-ca.pem",
      SSL_CERT_FILE: "/trusted/ssl-ca.pem",
    });
    const workspace = new NodeWorkerWorkspaceRuntime({
      root: path.join(root, "node-host"),
      env: { HOME: root, PATH: process.env.PATH, ...transport, ...platformTrust },
      ...(dedicated
        ? {
            managedIdentityTransport: captureNodeWorkerManagedIdentityTransport(transport),
            platformTrust,
          }
        : {}),
    });
    const owner = {
      gatewayNamespace: "lease-fixture",
      environmentId: "environment-1",
      sessionId: "session-1",
      generation: 1,
    };
    const created = await workspace.exec({
      ...owner,
      argv: ["node", "-e", "process.stdout.write(process.env.HOME ?? '')"],
    });
    const request = {
      workspaceDir: created.workspaceDir,
      environmentId: owner.environmentId,
      sessionId: owner.sessionId,
      ownerEpoch: owner.generation,
      sessionKey: "agent:main:lease",
    };
    const controller = new AbortController();
    let lease: Awaited<ReturnType<typeof workspace.acquireManagedWorkspaceAsync>> | undefined;
    try {
      await withNodeHostPluginInvocation(
        {
          sessionKey: request.sessionKey,
          signal: controller.signal,
          context: {
            sendNodeEvent: async () => undefined,
            acquireManagedWorkspaceAsync: (requested) =>
              workspace.acquireManagedWorkspaceAsync(requested),
          },
        },
        async (context) => {
          lease = await context!.acquireManagedWorkspaceAsync!(request);
          const environment = lease.processEnvironment!;
          if (ending === "settled") {
            // Project credentials once per admission mode; lifecycle rows share the same owner.
            expect(lease.homeDir).toBe(created.stdout);
            expect(lease.homeDir).toBe(path.dirname(created.workspaceDir));
            expect(JSON.stringify(lease)).not.toContain(header);
            const projected = environment.prepare({
              IDENTITY_ENDPOINT: "http://caller.invalid",
              IDENTITY_HEADER: "caller-override",
              ...(dedicated
                ? {
                    REQUESTS_CA_BUNDLE: "/caller/ca.pem",
                    SSL_CERT_FILE: "/caller/ca.pem",
                    NODE_EXTRA_CA_CERTS: "/caller/ca.pem",
                    NODE_USE_SYSTEM_CA: "0",
                  }
                : {}),
              PATH: "retained",
            });
            expect(projected).toEqual(
              dedicated
                ? { PATH: "retained", ...transport, ...platformTrust }
                : { PATH: "retained" },
            );
          }
          if (ending === "aborted") {
            controller.abort();
          }
          if (ending === "released") {
            lease.release();
          }
          if (ending === "retired") {
            await workspace.processes.stopEnvironment({ ...owner, ownerEpoch: owner.generation });
          }
          if (ending !== "settled") {
            expect(() => environment.prepare({})).toThrow();
          }
        },
      );
      expect(() => lease!.processEnvironment!.prepare({})).toThrow();
      // Redaction survives admission closure while already-started cleanup joins.
      expect(lease!.processEnvironment!.redactOutput(header)).toBe(
        dedicated ? "[REDACTED]" : header,
      );
    } finally {
      lease?.release();
      await workspace.processes.close();
    }
  });

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
    registry.plugins = [
      createPluginRecord({
        id: "workspace-plugin",
        source: "test",
        origin: "bundled",
        enabled: true,
        configSchema: true,
      }),
    ];
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
      registry.plugins = [
        createPluginRecord({
          id: "workspace-plugin",
          source: "test",
          origin: "bundled",
          enabled: true,
          configSchema: true,
        }),
      ];
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
