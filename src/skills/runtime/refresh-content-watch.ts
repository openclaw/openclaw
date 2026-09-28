import type { Result } from "@openclaw/normalization-core/result";
import { trackSkillsWatcherClose } from "./refresh-watch-close.js";
import type { SkillsDirectoryWatcher } from "./refresh-watch-types.js";

type ContentWatchGeneration = {
  watcher: SkillsDirectoryWatcher;
  revision: number;
  ready: boolean;
  readyDirectories: ReadonlySet<string>;
  errored: boolean;
  retired: boolean;
};

/** Keep native coverage while a directory rescan establishes its replacement. */
export function createSkillsContentWatcher(params: {
  watch(): SkillsDirectoryWatcher;
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
  let closing: Promise<Result<void, unknown>> | undefined;
  let retirementFailure: Result<void, unknown> | undefined;
  const retiring = new Set<Promise<Result<void, unknown>>>();
  const owns = (generation: ContentWatchGeneration) =>
    !closed &&
    !generation.retired &&
    params.isCurrent() &&
    (active === generation || pending === generation);
  const retire = (generation: ContentWatchGeneration) => {
    generation.retired = true;
    const retirement = generation.watcher.close();
    retiring.add(retirement);
    void retirement.then((result) => {
      if (!result.ok) {
        retirementFailure ??= result;
      }
      retiring.delete(retirement);
    });
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
      // Identical options make the transport's ready inventory conservative,
      // including any parent used to observe a logical symlink.
      generation.readyDirectories = new Set(watcher.directories);
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
    watcher.on("dirty", () => {
      if (owns(generation)) {
        revision += 1;
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
      if (closing) {
        return closing;
      }
      closed = true;
      retire(active);
      if (pending) {
        retire(pending);
        pending = undefined;
      }
      // Earlier generations can still be settling after promotion. Include
      // them and retain their first failure instead of certifying only pointers.
      closing = trackSkillsWatcherClose(async () => {
        await Promise.all(retiring);
        if (retirementFailure && !retirementFailure.ok) {
          throw retirementFailure.error;
        }
      });
      return closing;
    },
  };
}
