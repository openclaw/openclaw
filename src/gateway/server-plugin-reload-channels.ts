import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { listAmbientOnlyConfiguredChannelIds } from "../plugins/channel-presence-policy.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { prepareGatewayLifecycle } from "./server-lifecycle.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";

type ChannelManager = Awaited<ReturnType<typeof prepareGatewayLifecycle>>["channelManager"];

/** Keeps channel admission and route handoffs with one plugin reload operation. */
export function createPluginReloadChannels({
  channelManager,
  previousRegistry,
  skipChannels,
  previousStopStarted,
  reloadParams,
  ambientEnvTriggers,
}: {
  channelManager: ChannelManager;
  previousRegistry: PluginRegistry;
  skipChannels: boolean;
  previousStopStarted: () => boolean;
  reloadParams: Pick<
    Parameters<GatewayReloadHandlerParams["reloadPlugins"]>[0],
    "nextConfig" | "sourceConfig" | "env"
  >;
  ambientEnvTriggers: AmbientEnvTriggerPolicy;
}) {
  const channelTargets = new Set<ChannelId>();
  let releaseChannelStarts: ReturnType<ChannelManager["pauseChannelStarts"]> | undefined;
  const attempt = async (errors: unknown[], run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  const startReplacedChannels = async (
    registry: PluginRegistry,
    errors: unknown[],
    targets: ReadonlySet<ChannelId> = channelTargets,
  ) => {
    for (const { plugin } of registry.channels) {
      if (skipChannels || !targets.has(plugin.id)) {
        continue;
      }
      await attempt(errors, async () => {
        // Whole-channel targets include preparation that had not reserved an account at drain.
        const result = await channelManager.startChannel(plugin.id, undefined, {
          manual: false,
          preserveManualStop: true,
          skipUnavailableAccounts: true,
        });
        // Early rollback can retain a live account behind the public task-owned outcome.
        const failures = [...result].filter(
          ([accountId, outcome]) =>
            outcome.status === "retry" &&
            (previousStopStarted() ||
              outcome.reason !== "task-owned" ||
              !channelManager.hasCurrentAccountTask(plugin.id, accountId)),
        );
        if (failures.length) {
          throw new Error(
            `Plugin channel ${plugin.id} could not start: ${failures.map(([id]) => id).join(", ")}`,
          );
        }
      });
    }
  };
  const releaseChannelHandoffs = async (
    errors: unknown[],
    targets: ReadonlySet<ChannelId> = channelTargets,
  ) => {
    for (const channelId of targets) {
      // The manager keeps handoffs already admitted by successful accounts.
      await attempt(errors, () => channelManager.releaseChannelRouteHandoffs(channelId));
    }
  };
  const collectTargets = (nextRegistry: PluginRegistry, changedPluginIds: ReadonlySet<string>) => {
    if (
      previousRegistry.commands.some((entry) => !nextRegistry.commands.includes(entry)) ||
      nextRegistry.commands.some((entry) => !previousRegistry.commands.includes(entry))
    ) {
      // Pending starts can retain commands before their first catalog read.
      for (const channel of previousRegistry.channels) {
        channelTargets.add(channel.plugin.id);
      }
    }
    for (const channel of [...previousRegistry.channels, ...nextRegistry.channels]) {
      if (changedPluginIds.has(channel.pluginId)) {
        channelTargets.add(channel.plugin.id);
      }
    }
  };
  const stopAdditional = async (
    nextRegistry: PluginRegistry,
    changedPluginIds: ReadonlySet<string>,
  ) => {
    // Registration can introduce commands or channels absent from metadata. Preserve
    // their existing handoff policy before publishing the completed registry.
    const additionalChannels = new Set<ChannelId>();
    const commandsChanged =
      previousRegistry.commands.some((entry) => !nextRegistry.commands.includes(entry)) ||
      nextRegistry.commands.some((entry) => !previousRegistry.commands.includes(entry));
    for (const { plugin, pluginId } of [...previousRegistry.channels, ...nextRegistry.channels]) {
      if ((commandsChanged || changedPluginIds.has(pluginId)) && !channelTargets.has(plugin.id)) {
        additionalChannels.add(plugin.id);
        channelTargets.add(plugin.id);
      }
    }
    if (additionalChannels.size) {
      const releaseAdditional = channelManager.pauseChannelStarts(additionalChannels);
      const releasePrevious = releaseChannelStarts;
      releaseChannelStarts = (outcome, selected) => {
        releasePrevious?.(outcome, selected);
        releaseAdditional(outcome, selected);
      };
      for (const channelId of additionalChannels) {
        await channelManager.stopChannel(channelId, undefined, {
          manual: false,
          strict: true,
          routeHandoff: true,
        });
      }
    }
  };
  const stopPrevious = async (
    resourceHandoffIds: ReadonlySet<string>,
    errors: unknown[],
    cleanup: (label: string, run: () => Promise<void>) => Promise<void>,
  ) => {
    for (const { plugin, pluginId } of previousRegistry.channels) {
      if (!channelTargets.has(plugin.id)) {
        continue;
      }
      const stop = () =>
        channelManager.stopChannel(plugin.id, undefined, {
          manual: false,
          strict: true,
          routeHandoff: true,
        });
      if (resourceHandoffIds.has(pluginId)) {
        await attempt(errors, stop);
      } else {
        await cleanup(`Plugin channel ${plugin.id} cleanup failed`, stop);
      }
    }
  };
  return {
    channelTargets,
    stopPrevious,
    collectTargets,
    stopAdditional,
    startReplacedChannels,
    startPublishedChannels: async (
      registry: PluginRegistry,
      errors: unknown[],
      manifestRecords: Parameters<typeof listAmbientOnlyConfiguredChannelIds>[0]["manifestRecords"],
    ) => {
      try {
        channelManager.setAmbientAutostartSuppressedChannelIds(
          new Set(
            ambientEnvTriggers === "suppress"
              ? listAmbientOnlyConfiguredChannelIds({
                  config: reloadParams.nextConfig,
                  activationSourceConfig: reloadParams.sourceConfig,
                  env: reloadParams.env,
                  includePersistedAuthState: false,
                  manifestRecords,
                })
              : [],
          ),
        );
        await startReplacedChannels(registry, errors);
      } finally {
        await releaseChannelHandoffs(errors);
      }
    },
    releaseChannelHandoffs,
    restoreUnchanged: async (changedPluginIds: ReadonlySet<string>, errors: unknown[]) => {
      if (!releaseChannelStarts) {
        return;
      }
      const callableIds = new Set(
        previousRegistry.plugins
          .filter(
            (record) =>
              !changedPluginIds.has(record.id) && getPluginInstance(record)?.acceptingCalls,
          )
          .map((record) => record.id),
      );
      const targets = new Set(
        previousRegistry.channels
          .filter(
            ({ plugin, pluginId }) => channelTargets.has(plugin.id) && callableIds.has(pluginId),
          )
          .map(({ plugin }) => plugin.id),
      );
      // Command catalog changes can stop healthy siblings. A failed changed owner
      // must not strand their admission or force them to acquire a fresh instance.
      releaseChannelStarts("rollback", targets);
      try {
        await startReplacedChannels(previousRegistry, errors, targets);
      } finally {
        await releaseChannelHandoffs(errors, targets);
      }
    },
    pause: () => {
      releaseChannelStarts = channelManager.pauseChannelStarts(channelTargets);
    },
    release: (outcome: Parameters<NonNullable<typeof releaseChannelStarts>>[0]) => {
      releaseChannelStarts?.(outcome);
      releaseChannelStarts = undefined;
    },
  };
}
