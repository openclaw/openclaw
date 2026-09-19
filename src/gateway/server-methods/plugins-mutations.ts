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
> & { signal?: AbortSignal };

function lifecycleHandler<T>(
  method: string,
  validate: Validator<T>,
  run: (
    params: T,
    lifecycle: PluginLifecycleOptions,
    client: Parameters<GatewayRequestHandler>[0]["client"],
  ) => Promise<PluginLifecycleResult>,
): GatewayRequestHandler {
  return async ({ params, respond, context, signal, sessionMutationCommitGuard, client }) => {
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
        signal?.throwIfAborted();
        sessionMutationCommitGuard?.();
      };
      captured = captureGatewayPluginRuntimeApplications(applyRuntime, beforePersistentApply);
      const lifecycle: PluginLifecycleOptions = {
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
      return installManagedPlugin({ request: params, ...lifecycle });
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
