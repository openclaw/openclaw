/** Captures a prepared media source through preflight and accepted task work. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { acquirePluginCapabilityProviders } from "../../plugins/capability-provider-acquisition.js";
import type { CapabilityProviderFor } from "../../plugins/capability-provider-runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";

type MediaProviderKey =
  | "imageGenerationProviders"
  | "musicGenerationProviders"
  | "videoGenerationProviders";
type MediaProviderOptions = { cfg: OpenClawConfig; prepared?: PreparedModelRuntimeSnapshot };

export function acquireImageGenerationToolProviders(params: MediaProviderOptions) {
  return acquireMediaGenerationToolProviders("imageGenerationProviders", params);
}

export function acquireMusicGenerationToolProviders(params: MediaProviderOptions) {
  return acquireMediaGenerationToolProviders("musicGenerationProviders", params);
}

export function acquireVideoGenerationToolProviders(params: MediaProviderOptions) {
  return acquireMediaGenerationToolProviders("videoGenerationProviders", params);
}

async function acquireMediaGenerationToolProviders<K extends MediaProviderKey>(
  key: K,
  params: MediaProviderOptions,
) {
  const label = {
    imageGenerationProviders: "Image",
    musicGenerationProviders: "Music",
    videoGenerationProviders: "Video",
  }[key];
  const work = new AsyncWorkScope();
  const prepared = params.prepared;
  const inGeneration = <T>(run: () => T): T =>
    prepared
      ? withPluginRuntimeGenerationScope(
          { metadataSnapshot: prepared.metadataSnapshot, pluginRegistry: prepared.pluginRegistry },
          run,
        )
      : run();
  let captured:
    | ReturnType<NonNullable<PreparedModelRuntimeSnapshot["acquireMediaCapabilityProviders"]>>
    | undefined;
  let cold: Awaited<ReturnType<typeof acquirePluginCapabilityProviders<K>>> | undefined;
  let releaseCompletion: Promise<void> | undefined;
  const release = () =>
    (releaseCompletion ??= Promise.resolve().then(async () => {
      work.beginClose();
      try {
        await work.runWhenIdle(async () => {
          const errors: unknown[] = [];
          // A copied prepared registry can contribute callbacks without a second physical claim.
          // Drain the cold view's work before surrendering its original prepared source.
          for (const owner of [cold, captured]) {
            try {
              await owner?.release();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, `${label} provider resource cleanup failed`);
          }
        });
      } finally {
        await work.drain();
      }
    }));
  try {
    const providers = await work.track(async () => {
      captured = prepared?.acquireMediaCapabilityProviders?.();
      const knownProviders:
        | { [P in MediaProviderKey]?: readonly CapabilityProviderFor<P>[] }
        | undefined = captured ? captured.providers : prepared?.mediaCapabilityProviders;
      const known = knownProviders?.[key];
      if (known !== undefined) {
        return [...known];
      }
      cold = await inGeneration(() => acquirePluginCapabilityProviders({ key, cfg: params.cfg }));
      return cold.providers;
    });
    return {
      providers,
      assertOpen: () => {
        if (releaseCompletion) {
          throw new Error(`${label} provider resources have been released`);
        }
        captured?.assertOpen();
        cold?.assertOpen();
      },
      run: <T>(run: () => T | Promise<T>) =>
        releaseCompletion
          ? Promise.reject(new Error(`${label} provider resources have been released`))
          : work.track(() => inGeneration(() => (cold ? cold.run(run) : run()))),
      release,
    };
  } catch (error) {
    let cleanupFailure: { error: unknown } | undefined;
    try {
      await release();
    } catch (cleanupError) {
      cleanupFailure = { error: cleanupError };
    }
    if (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure.error],
        `${label} provider acquisition and cleanup failed`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}
