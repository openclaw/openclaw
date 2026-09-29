import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginCapabilityProvider } from "../plugins/capability-provider-runtime.js";
import type {
  LiveVisualProvider,
  LiveVisualSession,
} from "../plugins/live-visual-provider.types.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "../plugins/plugin-instance.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";

export type {
  LiveVisualAudioFormat,
  LiveVisualClock,
  LiveVisualHealth,
  LiveVisualInputEvent,
  LiveVisualOutput,
  LiveVisualProvider,
  LiveVisualSession,
  LiveVisualSessionOpenRequest,
  LiveVisualVideoFormat,
} from "../plugins/live-visual-provider.types.js";

function bindLiveVisualSession(
  session: LiveVisualSession,
  output: LiveVisualSession["output"],
  owner: PluginInstanceHandle,
  consumer: PluginInstanceConsumer,
): LiveVisualSession {
  let closeCompletion: Promise<void> | undefined;
  return {
    output,
    write: (event) => owner.run(() => session.write(event)),
    health: () => owner.run(() => session.health()),
    close: (reason) =>
      (closeCompletion ??= consumer.close(async () => {
        await session.close(reason);
      })),
  };
}

function bindLiveVisualProvider(
  provider: LiveVisualProvider,
  owner: PluginInstanceHandle,
): LiveVisualProvider {
  const descriptor = owner.run(() => ({ id: provider.id, label: provider.label }));
  return {
    ...descriptor,
    open: async (request) => {
      const { consumer: retainedConsumer, opening } = owner.run(() => {
        const consumer = owner.retainConsumer();
        try {
          return {
            consumer,
            opening: consumer.run(async () => {
              const session = await provider.open(request);
              if (!owner.acceptingCalls) {
                // Do not publish a session created across an owner cutover. Its retained
                // consumer still admits the terminal cleanup that retirement requires.
                await session.close("provider-retired");
                throw new PluginInstanceUnavailableError(owner.pluginId);
              }
              return { session, output: session.output };
            }),
          };
        } catch (error) {
          consumer.release();
          throw error;
        }
      });
      try {
        const { session, output } = await opening;
        return bindLiveVisualSession(session, output, owner, retainedConsumer);
      } catch (error) {
        retainedConsumer.release();
        throw error;
      }
    },
  };
}

function bindRegistryLiveVisualProvider(registry: PluginRegistry | undefined) {
  return (provider: LiveVisualProvider, pluginId: string): LiveVisualProvider => {
    const record = registry?.plugins.find((candidate) => candidate.id === pluginId);
    const owner = record && getPluginInstance(record);
    if (!owner) {
      return {
        id: provider.id,
        label: provider.label,
        open: async () => {
          throw new PluginInstanceUnavailableError(pluginId);
        },
      };
    }
    return bindLiveVisualProvider(provider, owner);
  };
}

/** Resolves one enabled live-visual provider from the active plugin generation. */
export function resolveLiveVisualProvider(params: {
  providerId: string;
  config?: OpenClawConfig;
}): LiveVisualProvider | undefined {
  return resolvePluginCapabilityProvider(
    {
      key: "liveVisualProviders",
      providerId: params.providerId,
      cfg: params.config,
    },
    bindRegistryLiveVisualProvider,
  );
}
