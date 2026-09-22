import type { FSWatcher } from "chokidar";
import { teardownSkillsPathWatcher } from "./refresh-watch-close.js";

type ContentWatchGeneration = { watcher: FSWatcher; revision: number; retired: boolean };

/** Keep native coverage while a directory rescan establishes its replacement. */
export function createSkillsContentWatcher(params: {
  watch(): FSWatcher;
  isCurrent(): boolean;
  isStructuralRaw(event: string, path: unknown, details: unknown): boolean;
  ready(rescan: boolean): void;
  changed(event: string, path: string): void;
  raw(event: string, path: unknown, details: unknown): void;
  error(error: unknown, rescan: boolean): void;
}) {
  let closed = false;
  let revision = 0;
  let active: ContentWatchGeneration;
  let pending: ContentWatchGeneration | undefined;
  const owns = (generation: ContentWatchGeneration) =>
    !closed &&
    !generation.retired &&
    params.isCurrent() &&
    (active === generation || pending === generation);
  const retire = (generation: ContentWatchGeneration) => {
    generation.retired = true;
    void teardownSkillsPathWatcher(generation);
  };
  const rescan = () => {
    if (!closed && params.isCurrent() && !pending) {
      pending = create();
    }
  };
  const create = (): ContentWatchGeneration => {
    const generation = { watcher: params.watch(), revision, retired: false };
    const { watcher } = generation;
    watcher.on("ready", () => {
      if (!owns(generation)) {
        return;
      }
      if (generation === active) {
        params.ready(false);
        return;
      }
      pending = undefined;
      if (generation.revision !== revision) {
        // A raw directory change can precede normalized addDir by an async scan.
        // Keep the observing generation until a complete scan sees that overlap.
        retire(generation);
        rescan();
        return;
      }
      const previous = active;
      active = generation;
      // Publication can synchronously close every watcher and snapshot the
      // native-close join set. Register retirement before handing control out.
      retire(previous);
      params.ready(true);
    });
    watcher.on("all", (event, changedPath) => {
      if (owns(generation)) {
        params.changed(event, changedPath);
      }
    });
    watcher.on("raw", (event, rawPath, details) => {
      if (!owns(generation)) {
        return;
      }
      // Polling reconciliation is deferred by the logical owner, but the raw
      // revision must be recorded now, before a pending ready can promote.
      if (params.isStructuralRaw(event, rawPath, details)) {
        revision += 1;
      }
      params.raw(event, rawPath, details);
    });
    watcher.on("error", (error) => {
      if (!owns(generation)) {
        return;
      }
      const isRescan = generation === pending;
      if (isRescan) {
        pending = undefined;
        retire(generation);
      }
      params.error(error, isRescan);
    });
    return generation;
  };
  active = create();
  return {
    rescan,
    structureChanged() {
      revision += 1;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      retire(active);
      if (pending) {
        retire(pending);
        pending = undefined;
      }
    },
  };
}
