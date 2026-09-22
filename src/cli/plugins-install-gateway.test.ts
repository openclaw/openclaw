import { describe, expect, it, vi } from "vitest";
import { pluginLifecycleError } from "../gateway/server-methods/plugins-lifecycle-error.js";
import { PluginInstallPersistedError } from "../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import { createGatewayPluginInstaller } from "./plugins-install-gateway.js";
import type { PluginLifecycleGateway } from "./plugins-lifecycle-client.js";

const request = { source: "npm", spec: "demo@1.2.3" } as const;
function wireError(cause: unknown) {
  const error = pluginLifecycleError(cause);
  return Object.assign(new Error(error.message), { details: error.details });
}

describe("Gateway plugin installation outcomes", () => {
  it.each(["lost reply", "saved install", "unclassified failure"])(
    "does not turn %s into permission to retry locally or probe hooks",
    async (phase) => {
      const cause = new ManagedPluginLifecycleError("source rejected", {
        installRejected: true,
        code: "missing_openclaw_extensions",
      });
      const error =
        phase === "lost reply"
          ? new Error("connection closed after send")
          : wireError(
              phase === "saved install"
                ? new PluginInstallPersistedError("demo", cause)
                : new Error("disk unavailable"),
            );
      const gateway = vi.fn(async () => {
        throw error;
      });
      const rejected = await createGatewayPluginInstaller(gateway)({ request }).catch(
        (failure: unknown) => failure,
      );
      if (phase === "saved install") {
        expect(rejected).toBeInstanceOf(PluginInstallPersistedError);
        expect(rejected).toMatchObject({ pluginId: "demo", cause: error });
        expect(rejected).toHaveProperty(
          "message",
          expect.stringContaining("installation is saved"),
        );
      } else {
        expect(rejected).toBe(error);
      }
      expect(gateway).toHaveBeenCalledExactlyOnceWith("plugins.install", request, undefined);
    },
  );

  it("preserves the install owner's selected artifact when permitting hook fallback", async () => {
    const source = {
      source: "npm",
      spec: "demo@1.2.3",
      expectedIntegrity: "sha512-reviewed",
    } as const;
    const error = wireError(
      new ManagedPluginLifecycleError("not a plugin", {
        installRejected: true,
        code: "missing_openclaw_extensions",
        installSource: source,
      }),
    );
    const gateway = vi.fn(async () => {
      throw error;
    });
    await expect(createGatewayPluginInstaller(gateway)({ request })).rejects.toMatchObject({
      installRejected: true,
      installSource: source,
      code: "missing_openclaw_extensions",
      cause: error,
    });
    expect(gateway).toHaveBeenCalledOnce();
  });

  it("returns the Gateway's applied generation and install result", async () => {
    const plugin = { id: "demo", name: "Demo", installed: true, enabled: true, state: "enabled" };
    const runtime = { operationId: "installed-demo", generation: 7, pluginIds: ["demo"] };
    const gateway = vi.fn<PluginLifecycleGateway>().mockResolvedValue({ plugin, runtime });
    await expect(
      createGatewayPluginInstaller(gateway as PluginLifecycleGateway)({ request }),
    ).resolves.toEqual({
      plugin,
      application: runtime,
      warnings: undefined,
    });
  });
});
