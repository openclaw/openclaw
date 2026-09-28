import nativeFs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import * as contentOwner from "./refresh-content-watch.js";
import type { SkillsDirectoryWatcher } from "./refresh-watch-types.js";

export function ready(watcher: Pick<SkillsDirectoryWatcher, "on">): Promise<void> {
  return new Promise((resolve, reject) => {
    watcher.on("ready", resolve);
    watcher.on("error", reject);
  });
}

export function deliverWindowsNotification(deliver: () => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    // Only callback spelling/dispatch is injected; filesystem custody stays real.
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    deliver();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

export const captureNativeCallbacks = (afterAcquire?: (directory: string) => void) => {
  const handles: Array<{
    directory: string;
    closed: boolean;
    deliver: (event: nativeFs.WatchEventType, filename: string | null) => void;
  }> = [];
  const originalWatch = nativeFs.watch;
  vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
    const deliver = args[1];
    if (typeof deliver !== "function") {
      throw new Error("Expected a shallow native callback");
    }
    // Keep real acquisition/retirement, but deliver only the named Windows
    // notification under test. This does not execute a Windows reparse ioctl.
    const native = originalWatch(args[0], () => {});
    const observed = { directory: path.resolve(String(args[0])), closed: false, deliver };
    handles.push(observed);
    native.once("close", () => {
      observed.closed = true;
    });
    try {
      afterAcquire?.(observed.directory);
    } catch (error) {
      native.close();
      throw error;
    }
    return native;
  });
  return handles;
};

export type ObservedSkillsWatcher = {
  watcher: { readonly closed: boolean };
  ready: boolean;
  paths: string | string[];
};

export function observeContentWatchers(
  observed: ObservedSkillsWatcher[],
  errors: unknown[],
  changes?: Array<[string, string]>,
  onError?: (error: unknown, observation: ObservedSkillsWatcher) => void,
) {
  const original = contentOwner.createSkillsContentWatcher;
  return vi.spyOn(contentOwner, "createSkillsContentWatcher").mockImplementation((params) =>
    original({
      ...params,
      watch: () => {
        const watcher = params.watch();
        const observation: ObservedSkillsWatcher = { watcher, ready: false, paths: [] };
        observed.push(observation);
        watcher.on("ready", () => {
          observation.paths = [...watcher.directories];
          observation.ready = true;
        });
        watcher.on("error", (error) => {
          errors.push(error);
          onError?.(error, observation);
        });
        if (changes) {
          watcher.on("all", (event, changedPath) => changes.push([event, changedPath]));
        }
        return watcher;
      },
    }),
  );
}
