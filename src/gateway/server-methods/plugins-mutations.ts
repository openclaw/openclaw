import {
  validatePluginsInstallParams,
  validatePluginsRefreshParams,
  validatePluginsReloadParams,
  validatePluginsSetEnabledParams,
  validatePluginsUninstallParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  PluginsInstallResult,
  PluginsUninstallResult,
} from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { withInstallActivity } from "../../infra/install-progress.js";
import { pluginInstallRequiresLocalHost } from "../../plugins/install-source-plan.js";
import type { PluginRuntimeApplication } from "../../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import {
  installManagedPlugin,
  refreshManagedPlugins,
  reloadManagedPlugin,
  setManagedPluginEnabled,
} from "../../plugins/management-mutations.js";
import { uninstallManagedPlugin } from "../../plugins/management-uninstall.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import {
  captureGatewayPluginRuntimeApplications,
  pluginLifecycleError,
} from "./plugins-lifecycle-error.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

type PluginLifecycleResult = Partial<
  Pick<PluginsInstallResult, "plugin" | "warnings"> &
    Pick<PluginsUninstallResult, "pluginId" | "removed">
> & { application?: PluginRuntimeApplication; pluginIds?: string[] };

type PluginLifecycleOptions = Required<
  Pick<Parameters<typeof installManagedPlugin>[0], "applyRuntime" | "beforePersistentApply">
> & { signal?: AbortSignal; logger?: import("../../plugins/install-types.js").PluginInstallLogger };

function lifecycleHandler<T>(
  method: string,
  validate: Validator<T>,
  run: (
    params: T,
    lifecycle: PluginLifecycleOptions,
    client: Parameters<GatewayRequestHandler>[0]["client"],
  ) => Promise<PluginLifecycleResult>,
): GatewayRequestHandler {
  return async ({
    req,
    params,
    respond,
    context,
    signal,
    sessionMutationCommitGuard,
    client,
    hasCurrentClientAuthority,
  }) => {
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    let captured: ReturnType<typeof captureGatewayPluginRuntimeApplications> | undefined;
    let entered = false;
    try {
      const applyRuntime = context.applyPluginLifecycleChange;
      if (!applyRuntime) {
        throw new Error("Plugin lifecycle changes require a running Gateway.");
      }
      const beforePersistentApply = () => {
        // Ordinary reconnects retain the request; credential revocation must fence every effect.
        if (
          hasCurrentClientAuthority?.() === false ||
          (client &&
            (client.invalidated ||
              (client.connect.role ?? "operator") !== "operator" ||
              !client.connect.scopes?.includes(ADMIN_SCOPE)))
        ) {
          throw new Error("Plugin mutation authority is no longer active.");
        }
        signal?.throwIfAborted();
        sessionMutationCommitGuard?.();
      };
      const connId = client?.connId;
      const logger: PluginLifecycleOptions["logger"] =
        method === "plugins.install" && connId
          ? {
              activity: (event) =>
                context.broadcastToConnIds(
                  "plugins.install.progress",
                  { ...event, requestId: req.id },
                  new Set([connId]),
                ),
            }
          : undefined;
      // Runtime application owns preparation through cleanup; its receipt is not final install success.
      captured = captureGatewayPluginRuntimeApplications(
        logger
          ? (change) => withInstallActivity(logger, "runtime", () => applyRuntime(change))
          : applyRuntime,
        beforePersistentApply,
      );
      const lifecycle: PluginLifecycleOptions = {
        ...(logger ? { logger } : {}),
        applyRuntime: captured.applyRuntime,
        beforePersistentApply,
        ...(signal ? { signal } : {}),
      };
      // A request must not wait on a config reload that is draining that request.
      const { application, plugin, pluginId, pluginIds, removed, warnings } =
        await withPluginLifecycleLease({ signal, waitMs: 0 }, () => {
          entered = true;
          return run(params, lifecycle, client);
        });
      if (!application) {
        throw new Error("Plugin lifecycle did not return a runtime application receipt.");
      }
      const { warnings: runtimeWarnings, ...runtime } = application;
      const combinedWarnings = [...new Set([...(warnings ?? []), ...(runtimeWarnings ?? [])])];
      respond(
        true,
        {
          ok: true,
          restartRequired: false,
          runtime,
          ...(plugin ? { plugin } : {}),
          ...(pluginId ? { pluginId } : {}),
          ...(pluginIds ? { pluginIds } : {}),
          ...(removed ? { removed } : {}),
          ...(combinedWarnings.length ? { warnings: combinedWarnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        pluginLifecycleError(error, { application: captured?.application, entered, signal }),
      );
    }
  };
}

export const pluginMutationHandlers: GatewayRequestHandlers = {
  "plugins.refresh": lifecycleHandler(
    "plugins.refresh",
    validatePluginsRefreshParams,
    (_params, lifecycle) => refreshManagedPlugins(lifecycle),
  ),
  "plugins.reload": lifecycleHandler(
    "plugins.reload",
    validatePluginsReloadParams,
    (params, lifecycle) => reloadManagedPlugin({ ...params, ...lifecycle }),
  ),
  "plugins.install": lifecycleHandler(
    "plugins.install",
    validatePluginsInstallParams,
    (params, lifecycle, client) => {
      if (pluginInstallRequiresLocalHost(params) && !client?.internal?.isLocalClient) {
        throw new ManagedPluginLifecycleError(
          "Local plugin artifacts require a connection from the Gateway host. Run `openclaw plugins install` on that host.",
        );
      }
      return installManagedPlugin({
        request: params,
        ...lifecycle,
        // The admin's install request accepts this staged surface, not new grants.
        // The artifact owner rechecks it before commit; no second request is needed.
        onCapabilityConsent: async (review) => {
          lifecycle.beforePersistentApply();
          return { reviewToken: review.reviewToken };
        },
      });
    },
  ),
  "plugins.uninstall": lifecycleHandler(
    "plugins.uninstall",
    validatePluginsUninstallParams,
    (params, lifecycle) => uninstallManagedPlugin({ ...params, ...lifecycle }),
  ),
  "plugins.setEnabled": lifecycleHandler(
    "plugins.setEnabled",
    validatePluginsSetEnabledParams,
    (params, lifecycle) => setManagedPluginEnabled({ ...params, ...lifecycle }),
  ),
};
