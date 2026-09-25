import { isDeepStrictEqual } from "node:util";
import { serializeConfigResolutionFacts } from "./resolution-facts.js";
import type { RuntimeConfigWriteNotification } from "./runtime-snapshot.js";
import { createConfigFileAdapter } from "./source-file.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

export function configSourceSnapshotsMatch(
  left: ConfigFileSnapshot,
  right: ConfigFileSnapshot,
): boolean {
  return (
    left.exists === right.exists &&
    left.valid === right.valid &&
    left.hash === right.hash &&
    isDeepStrictEqual(left.sourceConfig, right.sourceConfig) &&
    isDeepStrictEqual(left.includedPaths, right.includedPaths) &&
    isDeepStrictEqual(left.includeProvenance, right.includeProvenance) &&
    isDeepStrictEqual(
      serializeConfigResolutionFacts(left.sourceConfig),
      serializeConfigResolutionFacts(right.sourceConfig),
    )
  );
}

export type ConfigSourceObservation = {
  revision: number;
  writerRevision: number;
  write?: RuntimeConfigWriteNotification;
  snapshot?: Promise<ConfigFileSnapshot>;
};

/** Source admission is separate from application: reload mode can retain an older runtime. */
export function createConfigSource(opts: {
  path: string;
  includedPaths?: readonly string[];
  readSnapshot: () => Promise<ConfigFileSnapshot>;
  subscribeToWrites?: (listener: (event: RuntimeConfigWriteNotification) => void) => () => void;
  onObserved: (observation: ConfigSourceObservation) => void;
  onReady: (isCurrent: () => boolean) => void;
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}) {
  let stopped = false;
  let observation: ConfigSourceObservation = { revision: 0, writerRevision: 0 };
  let acceptedRevision = 0;
  const observe = (write?: RuntimeConfigWriteNotification) => {
    if (stopped) {
      return;
    }
    const reconcileFile = write && !observation.write && observation.revision > acceptedRevision;
    const revision = observation.revision + 1;
    observation = {
      revision,
      writerRevision: write ? revision : observation.writerRevision,
      ...(write ? { write, snapshot: Promise.resolve(write.snapshot) } : {}),
    };
    opts.onObserved(observation);
    // A notification cannot consume an external edit still awaiting source admission.
    if (reconcileFile) {
      observe();
    }
  };
  const files = createConfigFileAdapter({
    path: opts.path,
    includedPaths: opts.includedPaths,
    onChange: () => observe(),
    onReady: opts.onReady,
    log: opts.log,
  });
  const unsubscribe = opts.subscribeToWrites?.((write) => {
    if (write.configPath === opts.path) {
      observe(write);
    }
  });
  return {
    get observation() {
      return observation;
    },
    start: files.start,
    observe,
    accept(revision: number) {
      if (revision === observation.revision) {
        acceptedRevision = revision;
      }
    },
    readSnapshot(current = observation): Promise<ConfigFileSnapshot> {
      // All consumers of an observation share its resolved bytes and include provenance.
      return (current.snapshot ??= opts.readSnapshot());
    },
    observePaths: files.observePaths,
    acceptPaths: files.acceptPaths,
    status: files.status,
    async stop() {
      stopped = true;
      unsubscribe?.();
      await files.stop();
    },
  };
}
