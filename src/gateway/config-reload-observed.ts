import type { ConfigSourceObservation } from "../config/source.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";

export type ConfigReloadObservation = Readonly<{
  generation: number;
  sourceConfig: OpenClawConfig | null;
}>;

type ObservedSnapshot = Pick<ConfigFileSnapshot, "exists" | "valid" | "sourceConfig">;

// The reloader owns config-source reads. Publish one immutable record so health
// cannot combine a generation from one transaction with source from another.
let configReloadObservation: ConfigReloadObservation = {
  generation: 0,
  sourceConfig: null,
};

export function publishReloadObservation(sourceConfig: OpenClawConfig | null): void {
  configReloadObservation = {
    generation: configReloadObservation.generation + 1,
    sourceConfig,
  };
}

export function getConfigReloadObservation(): ConfigReloadObservation {
  return configReloadObservation;
}

/**
 * Couples reloader transactions to the published observation. Each transaction
 * holds its source read until it finishes, then publishes it only while its
 * source revision is current, so a newer write or file event revokes it first.
 * A same-source watcher echo that the transaction accepted keeps its read current.
 */
export function trackReloadObservations(current: () => ConfigSourceObservation) {
  const acceptedEchoOrigins = new WeakMap<ConfigSourceObservation, number>();
  return {
    acceptEcho(observed: ConfigSourceObservation, fromRevision: number) {
      acceptedEchoOrigins.set(observed, fromRevision);
    },
    track() {
      let candidate: { revision: number; sourceConfig: OpenClawConfig | null } | null = null;
      const observeSnapshot = (revision: number, snapshot: ObservedSnapshot) => {
        candidate = {
          revision,
          sourceConfig: snapshot.exists && snapshot.valid ? snapshot.sourceConfig : null,
        };
      };
      return {
        observeSnapshot,
        /** A failed read publishes as unavailable rather than keeping the prior source. */
        async read<T extends ObservedSnapshot>(revision: number, read: () => Promise<T>) {
          candidate = { revision, sourceConfig: null };
          const snapshot = await read();
          observeSnapshot(revision, snapshot);
          return snapshot;
        },
        publishIfCurrent() {
          const observation = current();
          if (
            candidate &&
            (candidate.revision === observation.revision ||
              candidate.revision === acceptedEchoOrigins.get(observation))
          ) {
            publishReloadObservation(candidate.sourceConfig);
          }
        },
      };
    },
  };
}
