import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createOptimisticStore,
  refresh,
} from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.tsx";
import type { PluginMutationPresentation } from "./plugins-consent.ts";

export function createPluginsMutationPresentation(options: {
  gateway: GatewayPageBinding;
  read: () => { result: PluginListResult | null };
  isActive: () => boolean;
  lifetime: () => Promise<void>;
  catalog: () => Promise<void> | null;
  setMessage: (rowKey: string, message: PluginRowMessage | null) => void;
}) {
  const inventory = createMemo(() => options.read().result);
  const mutationEpoch = createMemo(() => {
    options.read();
    return options.gateway.epoch;
  });
  const mutationPresentation = createMemo(() => {
    const epoch = mutationEpoch();
    const [plugins, setPlugins] = createOptimisticStore(() => inventory()?.plugins ?? [], [], {
      key: "id",
    });
    const [saving, setSaving] = createOptimistic(false);
    return { epoch, plugins, setPlugins, saving, setSaving };
  });
  const presentMutation = action(function* (
    view: ReturnType<typeof mutationPresentation>,
    mutation: PluginMutationPresentation,
    retired: Promise<void>,
  ) {
    const isCurrent = () =>
      options.isActive() &&
      view.epoch === options.gateway.epoch &&
      options.gateway.isCurrent(mutation.scope);
    try {
      if (isCurrent()) {
        view.setSaving(true);
        if (mutation.action !== "uninstall") {
          view.setPlugins((plugins) => {
            const plugin = plugins.find((entry) => pluginRowKey(entry.id) === mutation.rowKey);
            if (plugin) {
              plugin.enabled = mutation.action === "enable";
            }
          });
        }
        // Runtime status, versions, and removed rows come from the owner's accepted response.
        affects(options.catalog);
      }
      yield Promise.race([mutation.result, retired]);
      if (isCurrent()) {
        yield refresh(view.plugins);
      }
    } catch (error) {
      if (isCurrent()) {
        options.setMessage(mutation.rowKey, { kind: "error", text: formatUiError(error) });
      }
    }
  });
  return {
    enabled: (pluginId: string) =>
      mutationPresentation().plugins.find((plugin) => plugin.id === pluginId)?.enabled,
    saving: () => mutationPresentation().saving(),
    present: async (mutation: PluginMutationPresentation) => {
      const view = mutationPresentation();
      const retired = options.lifetime();
      // The plain owner's synchronous busy publication precedes the action transition.
      await Promise.resolve();
      await presentMutation(view, mutation, retired);
    },
  };
}
