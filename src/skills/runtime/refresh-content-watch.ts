import type { FSWatcher } from "chokidar";
import { teardownSkillsPathWatcher } from "./refresh-watch-close.js";

type ContentWatchGeneration = {
  watcher: FSWatcher;
  revision: number;
  ready: boolean;
  readyDirectories: ReadonlySet<string>;
  errored: boolean;
  retired: boolean;
};

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
  let published = false;
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
    if (!closed && params.isCurrent() && (active.ready || active.errored) && !pending) {
      pending = create();
    }
  };
  const create = (): ContentWatchGeneration => {
    const generation: ContentWatchGeneration = {
      watcher: params.watch(),
      revision,
      ready: false,
      readyDirectories: new Set(),
      errored: false,
      retired: false,
    };
    const { watcher } = generation;
    watcher.on("ready", () => {
      if (!owns(generation) || generation.ready) {
        return;
      }
      generation.ready = true;
      // Later discovery cannot prove a directory was observed before verification.
      // Identical watch options make all getWatched keys a conservative inventory,
      // including bookkeeping parents; this is not a native-handle census.
      generation.readyDirectories = new Set(Object.keys(watcher.getWatched()));
      if (generation === active) {
        // Chokidar lists before registering native watches. Verify that first
        // listing under an observing generation before publishing readiness.
        rescan();
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
      if (
        previous.errored ||
        Array.from(generation.readyDirectories).some(
          (directory) => !previous.readyDirectories.has(directory),
        )
      ) {
        // A newly discovered directory has its own list-before-watch gap.
        // Establish its observer before verifying it, however deep discovery goes.
        rescan();
        return;
      }
      const isRescan = published;
      published = true;
      params.ready(isRescan);
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
      generation.errored = true;
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
