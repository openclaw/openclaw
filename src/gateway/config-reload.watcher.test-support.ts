import path from "node:path";
import { vi } from "vitest";
import type { createConfigFileAdapter } from "../config/source-file.js";

/** Gateway tests inject source notifications; filesystem lifecycle is proved by adapter tests. */
export function createWatcherMock() {
  let options: Parameters<typeof createConfigFileAdapter>[0] | undefined;
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
    attach: (next: Parameters<typeof createConfigFileAdapter>[0]) => {
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
