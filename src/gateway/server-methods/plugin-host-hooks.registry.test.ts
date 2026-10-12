import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../../config/sessions/session-sharing-store.js";
import {
  clearActivePluginRegistry,
  createPluginRegistryOwner,
  getActivePluginRegistryVersion,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { READ_SCOPE, WRITE_SCOPE, type OperatorScope } from "../operator-scopes.js";
import { handleGatewayRequest } from "../server-methods.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { pluginHostHookHandlers } from "./plugin-host-hooks.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandler } from "./types.js";

describe("plugin host hook registry ownership", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearActivePluginRegistry();
  });

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
      setActivePluginRegistry(local);
      const localGeneration = getActivePluginRegistryVersion();
      const localOwner = createPluginRegistryOwner(local);
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
                generation: localGeneration,
                descriptors: [{ pluginId, id: "panel", label: "Local registry" }],
              },
        ]);
      } finally {
        await localOwner.close();
        await disposePluginRegistryInstances(local);
      }
    },
  );

  it.for(["current", "device revoked", "membership removed"] as const)(
    "fences session actions after row preparation when authority is %s",
    async (authority, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = rolePolicyConfig();
        await state.writeConfig(cfg);
        const client = roleClient("view", "plugin-action-member");
        const memberId = client.authenticatedUserProfile!.profileId;
        const sessionKey = "agent:main:plugin-action-authority";
        const scope = { agentId: "main", sessionKey };
        const sessionId = "plugin-action-authority";
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: 1,
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: "another-profile" },
        });
        await addSessionMember(scope, {
          identityId: memberId,
          addedBy: "another-profile",
          expectedSessionId: sessionId,
        });
        const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        const context = bindSessionRowProjection(
          { getRuntimeConfig: () => cfg } as GatewayRequestContext,
          () => projection,
        );
        const deviceId = "plugin-action-device";
        const deviceAuthority = captureGatewayDeviceRevocation(
          context,
          { deviceId, role: "operator" },
          () => true,
        );
        const effects: Array<string | undefined> = [];
        const pluginId = "authority-host-hooks";
        const { config, registry } = createPluginRegistryFixture();
        registerTestPlugin({
          config,
          registry,
          record: createPluginRecord({ id: pluginId }),
          register(api) {
            api.registerSessionAction({
              id: "mutate",
              requiredScopes: [WRITE_SCOPE],
              handler: (request) => {
                effects.push(request.sessionKey);
                return { result: { applied: true } };
              },
            });
          },
        });
        setActivePluginRegistry(registry.registry);
        const registryOwner = createPluginRegistryOwner(registry.registry);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const prepare = projection.withPreparedExactRows.bind(projection);
        const handler: GatewayRequestHandler = (options) => {
          // Install the wait only after the real router has admitted this member.
          // Both admission and resumed preparation still use the real row owner.
          vi.spyOn(projection, "withPreparedExactRows").mockImplementationOnce(
            async (queries, consume, preparationOptions) => {
              entered.resolve();
              await release.promise;
              return prepare(queries, consume, preparationOptions);
            },
          );
          return pluginHostHookHandlers["plugins.sessionAction"]!(options);
        };
        const methodRegistry = createGatewayMethodRegistry(
          createCoreGatewayMethodDescriptors({
            ...pluginHostHookHandlers,
            "plugins.sessionAction": handler,
          }),
          registry.registry,
        );
        const respond = vi.fn();
        const request = handleGatewayRequest({
          req: {
            id: "held-session-action",
            type: "req",
            method: "plugins.sessionAction",
            params: { pluginId, actionId: "mutate", sessionKey },
          },
          client,
          context,
          methodRegistry,
          respond,
          hasCurrentClientAuthority: deviceAuthority.isCurrent,
          isWebchatConnect: () => false,
        });
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              entered.promise,
              request,
              "session action settled before its row-preparation boundary",
            ),
            signal,
          );
          expect(effects).toEqual([]);
          expect(respond).not.toHaveBeenCalled();
          if (authority === "device revoked") {
            invalidateGatewayDeviceRevocation(context, deviceId, "operator");
          } else if (authority === "membership removed") {
            expect(await removeSessionMember(scope, memberId, undefined, sessionId)).not.toBeNull();
          }
          // Neither revocation changes the scopes captured by the action handler.
          expect(client.connect.scopes).toEqual([READ_SCOPE, WRITE_SCOPE]);
          release.resolve();
          await withinTest(request, signal);
          expect(respond).toHaveBeenCalledOnce();
          if (authority === "current") {
            expect(effects).toEqual([sessionKey]);
            expect(respond).toHaveBeenCalledWith(true, { ok: true, result: { applied: true } });
          } else {
            expect(effects).toEqual([]);
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({ code: "UNAVAILABLE" }),
            );
          }
        } finally {
          release.resolve();
          try {
            await request;
          } finally {
            deviceAuthority.release();
            closeGatewayDeviceRevocation(context);
            projection.dispose();
            await registryOwner.close();
            await disposePluginRegistryInstances(registry.registry);
          }
        }
      });
    },
  );
});
