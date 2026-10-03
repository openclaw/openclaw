import type { SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, vi } from "vitest";
import type { createRunNodePathClassifier } from "../../scripts/run-node-watch-paths.mts";
import type { WatcherFactory } from "../../scripts/watch-node-observation.mts";
import { createScriptTestHarness } from "./test-helpers.js";

type WatchExit = number | NodeJS.Signals;
export type WatchFixture = {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  process: NodeJS.Process;
  spawn: (command: string, args: string[], options: SpawnOptions) => unknown;
  createWatcher?: WatcherFactory;
  loadWatcher?: () => Promise<WatcherFactory>;
  pathClassifier?: Pick<
    ReturnType<typeof createRunNodePathClassifier>,
    "refreshGeneratedPluginAssetPaths" | "isRestartRelevantRunNodePath"
  >;
  fs?: Pick<typeof fs, "existsSync">;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
};

const { createTempDir } = createScriptTestHarness();
let ready: Promise<void>;
export const watchReady = () => ready;

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("node:process");
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../scripts/watch-node-observation.mts");
  vi.doUnmock("../../scripts/run-node-watch-paths.mts");
  vi.doUnmock("../../scripts/lib/sleep.mjs");
});

export function runWatch(params: WatchFixture): Promise<WatchExit> {
  const admission = Promise.withResolvers<void>();
  ready = admission.promise;
  const run = (async () => {
    vi.resetModules();
    const cwd = params.cwd ?? createTempDir("openclaw-watch-boundary-");
    const fakeProcess = Object.assign(params.process, {
      cwd: () => cwd,
      argv: [process.execPath, "watch-fixture", ...(params.args ?? [])],
      env: params.env ?? { ...process.env },
      platform: params.process.platform ?? process.platform,
      stdin: params.process.stdin ?? { isTTY: false },
      stderr: params.process.stderr ?? { write: () => true },
      kill:
        params.signalProcess ??
        (() => {
          throw new Error("Unexpected process signal in watch fixture");
        }),
    });
    vi.doMock("node:process", () => ({ default: fakeProcess }));
    vi.doMock("node:child_process", async () => ({
      ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
      spawn: params.spawn,
    }));
    vi.doMock("../../scripts/watch-node-observation.mts", async () => {
      let factory = params.createWatcher;
      if (params.loadWatcher) {
        const loading = params.loadWatcher();
        admission.resolve();
        try {
          factory = await loading;
        } catch (error) {
          return {
            get createSourceObserver() {
              throw error;
            },
          };
        }
      }
      const createObserver = factory;
      if (!createObserver) {
        throw new Error("Watch fixture needs a source observer");
      }
      return {
        createSourceObserver: (...args: Parameters<WatcherFactory>) => {
          const watcher = createObserver(...args);
          admission.resolve();
          return watcher;
        },
      };
    });
    if (params.pathClassifier) {
      vi.doMock("../../scripts/run-node-watch-paths.mts", async () => ({
        ...(await vi.importActual<typeof import("../../scripts/run-node-watch-paths.mts")>(
          "../../scripts/run-node-watch-paths.mts",
        )),
        createRunNodePathClassifier: () => params.pathClassifier,
      }));
    }
    if (params.fs) {
      const exists = fs.existsSync;
      const distEntry = path.join(cwd, "dist", "entry.js");
      vi.spyOn(fs, "existsSync").mockImplementation((candidate) =>
        candidate === distEntry ? params.fs!.existsSync(candidate) : exists(candidate),
      );
    }
    if (params.now) {
      vi.spyOn(Date, "now").mockImplementation(params.now);
    }
    if (params.sleep) {
      vi.doMock("../../scripts/lib/sleep.mjs", () => ({ sleep: params.sleep }));
    }
    const { runWatchMain } = await import("../../scripts/watch-node.mts");
    return await runWatchMain();
  })();
  void run.then(
    () => admission.resolve(),
    () => admission.resolve(),
  );
  return run;
}
