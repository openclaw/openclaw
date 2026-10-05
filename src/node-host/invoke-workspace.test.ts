import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayClient } from "../gateway/client.js";
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
  it.each(["settled", "aborted", "released", "retired"])(
    "fences a real managed process environment after %s",
    async (ending) => {
      const root = await fs.realpath(tempDirs.make("node-managed-process-env-"));
      const header = "synthetic-invocation-provider-header";
      const platformTrust = captureNodeWorkerPlatformTrust({
        REQUESTS_CA_BUNDLE: "/trusted/requests-ca.pem",
        SSL_CERT_FILE: "/trusted/ssl-ca.pem",
      });
      const workspace = new NodeWorkerWorkspaceRuntime({
        root: path.join(root, "node-host"),
        env: { HOME: root, PATH: process.env.PATH },
        managedIdentityTransport: captureNodeWorkerManagedIdentityTransport({
          IDENTITY_ENDPOINT: "http://127.0.0.1:40342/identity",
          IDENTITY_HEADER: header,
        }),
        platformTrust,
      });
      const owner = {
        gatewayNamespace: "lease-fixture",
        environmentId: "environment-1",
        sessionId: "session-1",
        generation: 1,
      };
      const created = await workspace.exec({ ...owner, argv: ["node", "-e", ""] });
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
            expect(
              environment.prepare({ IDENTITY_HEADER: "caller-override" }).IDENTITY_HEADER,
            ).toBe(header);
            const projected = environment.prepare({
              REQUESTS_CA_BUNDLE: "/caller/ca.pem",
              SSL_CERT_FILE: "/caller/ca.pem",
              NODE_EXTRA_CA_CERTS: "/caller/ca.pem",
              NODE_USE_SYSTEM_CA: "0",
            });
            expect(projected.REQUESTS_CA_BUNDLE).toBe(platformTrust.REQUESTS_CA_BUNDLE);
            expect(projected.SSL_CERT_FILE).toBe(platformTrust.SSL_CERT_FILE);
            expect(projected.NODE_EXTRA_CA_CERTS).toBeUndefined();
            expect(projected.NODE_USE_SYSTEM_CA).toBeUndefined();
            expect(JSON.stringify(lease)).not.toContain(header);
            expect(environment.redactOutput(`header=${header}`)).toBe("header=[REDACTED]");
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
              expect(() => environment.assertCurrent()).toThrow();
            }
          },
        );
        expect(() => lease!.processEnvironment!.prepare({})).toThrow();
        expect(() => lease!.processEnvironment!.assertCurrent()).toThrow();
        // Redaction remains available while already-started process cleanup joins.
        expect(lease!.processEnvironment!.redactOutput(header)).toBe("[REDACTED]");
      } finally {
        lease?.release();
        await workspace.processes.close();
      }
    },
  );

  it("keeps a default managed device lease sterile despite ambient and caller-supplied identity variables", async () => {
    const root = await fs.realpath(tempDirs.make("node-default-process-env-"));
    const workspace = new NodeWorkerWorkspaceRuntime({
      root: path.join(root, "node-host"),
      env: {
        HOME: root,
        PATH: process.env.PATH,
        IDENTITY_ENDPOINT: "http://127.0.0.1:40342/identity",
        IDENTITY_HEADER: "synthetic-unadmitted-header",
        REQUESTS_CA_BUNDLE: "/ambient/requests-ca.pem",
        SSL_CERT_FILE: "/ambient/ssl-ca.pem",
      },
    });
    const owner = {
      gatewayNamespace: "device-fixture",
      environmentId: "environment-1",
      sessionId: "session-1",
      generation: 1,
    };
    const created = await workspace.exec({ ...owner, argv: ["node", "-e", ""] });
    const lease = await workspace.acquireManagedWorkspaceAsync({
      workspaceDir: created.workspaceDir,
      environmentId: owner.environmentId,
      sessionId: owner.sessionId,
      ownerEpoch: 1,
      sessionKey: "agent:main:device",
    });
    try {
      const projected = lease.processEnvironment!.prepare({
        IDENTITY_ENDPOINT: "http://caller.invalid",
        IDENTITY_HEADER: "caller-override",
        PATH: "retained",
      });
      expect(projected).toEqual({ PATH: "retained" });
      expect(JSON.stringify(lease)).not.toContain("synthetic-unadmitted-header");
    } finally {
      lease.release();
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
