import type { Root } from "@openclaw/fs-safe/root";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { readObservationSnapshot } from "../infra/fs-observation-snapshot.js";

type ConfigWatchFile = { root: Root; relative: string };

/** Config parsing waits for 200ms of unchanged guarded metadata, not backend readiness. */
export function createConfigFileStability(onChange: () => void, onError: (error: unknown) => void) {
  const files = new Map<Root, Map<string, string | undefined>>();
  let stopped = false;
  let revision = 0;
  let stableSince = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<void> | undefined;
  let failure: Error | undefined;
  const schedule = () => {
    if (!stopped && !timer && !checking) {
      timer = setTimeout(check, 50);
    }
  };
  const check = (): void => {
    timer = undefined;
    const observedRevision = revision;
    checking = Promise.resolve()
      .then(async () => {
        if (stopped) {
          return;
        }
        let changed = false;
        for (const [root, entries] of files) {
          for (const [relative, previous] of entries) {
            const metadata = await readObservationSnapshot(root, relative);
            const snapshot = metadata && `${metadata.size}:${metadata.mtimeMs}`;
            if (stopped || revision !== observedRevision) {
              return;
            }
            changed ||= snapshot !== previous;
            entries.set(relative, snapshot);
          }
        }
        if (changed) {
          stableSince = performance.now();
        }
        if (!stopped && performance.now() - stableSince >= 200) {
          files.clear();
          onChange();
        }
      })
      .catch((error: unknown) => {
        failure ??= toErrorObject(error, "Config file settling failed");
        onError(error);
      })
      .finally(() => {
        checking = undefined;
        if (files.size > 0) {
          schedule();
        }
      });
  };
  return {
    dirty(paths: Iterable<ConfigWatchFile>) {
      if (stopped) {
        return;
      }
      revision += 1;
      stableSince = performance.now();
      for (const file of paths) {
        const entries = files.get(file.root) ?? new Map<string, string | undefined>();
        entries.set(file.relative, undefined);
        files.set(file.root, entries);
      }
      schedule();
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      await checking;
      files.clear();
      if (failure !== undefined) {
        throw failure;
      }
    },
  };
}
