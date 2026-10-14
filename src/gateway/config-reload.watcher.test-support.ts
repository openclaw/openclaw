import path from "node:path";
import { vi } from "vitest";
import * as configFileSource from "../config/source-file.js";

type WatcherOptions = Parameters<typeof configFileSource.createConfigFileAdapter>[0];

/** Gateway tests inject source notifications; filesystem lifecycle is proved by adapter tests. */
export function createWatcherMock() {
  let options: WatcherOptions | undefined;
  let accepted: readonly string[] = [];
  let paths: string[] = [];
  let active = false;
  let generation = 0;
  const reconcile = (includes: readonly string[]) => {
    paths = [...new Set([options!.path, ...includes].map((entry) => path.resolve(entry)))];
  };
  const close = vi.fn(async () => {
    active = false;
    generation += 1;
  });
  const adapter = {
    start: vi.fn(() => {
      active = true;
    }),
    observePaths: vi.fn(async (includes: readonly string[]) =>
      reconcile([...accepted, ...includes]),
    ),
    acceptPaths: vi.fn(async (includes: readonly string[]) => {
      accepted = includes;
      reconcile(includes);
    }),
    stop: close,
    status: () => "active" as const,
  };
  return {
    close,
    adapter,
    get paths() {
      return paths;
    },
    attach: (next: WatcherOptions) => {
      options = next;
      accepted = next.includedPaths ?? [];
      reconcile(accepted);
      return adapter;
    },
    emit(event: "add" | "change" | "unlink" | "error" | "ready", value?: unknown) {
      if (!active || !options) {
        return;
      }
      if (event === "error") {
        generation += 1;
        return;
      }
      if (event === "ready") {
        const observed = generation;
        options.onReady?.(() => active && generation === observed);
      } else if (paths.includes(path.resolve(typeof value === "string" ? value : options.path))) {
        options.onChange();
      }
    },
  };
}

export function installWatcherMock() {
  const watcher = createWatcherMock();
  const watch = vi
    .spyOn(configFileSource, "createConfigFileAdapter")
    .mockImplementation(watcher.attach);
  return Object.assign(watcher, { restore: () => watch.mockRestore() });
}
