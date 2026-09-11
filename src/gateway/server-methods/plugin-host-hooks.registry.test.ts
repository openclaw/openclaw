import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { READ_SCOPE, WRITE_SCOPE, type OperatorScope } from "../operator-scopes.js";
import { handleGatewayRequest } from "../server-methods.js";
import { pluginHostHookHandlers } from "./plugin-host-hooks.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

describe("plugin host hook registry ownership", () => {
  afterEach(() => clearActivePluginRegistry());

  it.each([
    ["plugins.uiDescriptors", WRITE_SCOPE],
    ["plugins.sessionAction", WRITE_SCOPE],
    ["plugins.sessionAction", READ_SCOPE],
  ] as const)(
    "%s with %s selects the registry attached to the admitted request",
    async (method, scope) => {
      const pluginId = "local-host-hooks";
      const fixture = (label: string, requiredScope: OperatorScope) => {
        const { config, registry } = createPluginRegistryFixture();
        registerTestPlugin({
          config,
          registry,
          record: createPluginRecord({ id: pluginId }),
          register(api) {
            api.registerControlUiDescriptor({ id: "panel", surface: "session", label });
            api.registerSessionAction({
              id: "describe",
              requiredScopes: [requiredScope],
              handler: () => ({ result: { label } }),
            });
          },
        });
        return registry.registry;
      };
      const local = fixture("Local registry", scope);
      const processDefault = fixture("Process default", WRITE_SCOPE);
      markPluginRegistryActive(local);
      setActivePluginRegistry(processDefault);
      const methodRegistry = createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors(pluginHostHookHandlers),
        local,
      );
      const respond = vi.fn();
      try {
        await handleGatewayRequest({
          req: {
            id: "local-registry",
            type: "req",
            method,
            params: method === "plugins.sessionAction" ? { pluginId, actionId: "describe" } : {},
          },
          methodRegistry,
          client: { connect: { role: "operator", scopes: [scope] } } as GatewayClient,
          isWebchatConnect: () => false,
          respond,
          context: {
            getRuntimeConfig: () => ({}),
            getGatewayMethodRegistry: () => methodRegistry,
          } as GatewayRequestContext,
        });
        expect(respond.mock.calls).toHaveLength(1);
        expect(respond.mock.calls[0]?.slice(0, 2)).toMatchObject([
          true,
          method === "plugins.sessionAction"
            ? { ok: true, result: { label: "Local registry" } }
            : {
                ok: true,
                descriptors: [{ pluginId, id: "panel", label: "Local registry" }],
              },
        ]);
      } finally {
        await disposePluginRegistryInstances(local);
      }
    },
  );
});
