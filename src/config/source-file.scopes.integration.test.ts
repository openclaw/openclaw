import fs from "node:fs/promises";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import * as observation from "@openclaw/fs-safe/watch";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createConfigFileAdapter } from "./source-file.js";

vi.mock("@openclaw/fs-safe/watch", async (original) => ({
  ...(await original<typeof import("@openclaw/fs-safe/watch")>()),
}));
const sourceCleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  await Promise.all([...sourceCleanups].map((cleanup) => cleanup()));
  sourceCleanups.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function fixture(directory: string, includes: string[] = []) {
  const configDir = path.join(directory, "config");
  const sharedDir = path.join(directory, "shared");
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(sharedDir, { recursive: true });
  const configPath = path.join(configDir, "openclaw.json");
  await fs.writeFile(configPath, "{}");
  const ready = createDeferred();
  const sources: observation.WatchSubscription[] = [];
  const samples: Promise<unknown>[] = [];
  const instrumented = new WeakSet<Root>();
  let sourceCreated: ((source: observation.WatchSubscription) => void) | undefined;
  const actualWatch = observation.watch;
  vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    if (!instrumented.has(authority)) {
      instrumented.add(authority);
      const open = authority.open.bind(authority);
      vi.spyOn(authority, "open").mockImplementation((...args) => {
        const pending = open(...args).then((opened) => {
          const dispose = opened[Symbol.asyncDispose].bind(opened);
          vi.spyOn(opened, Symbol.asyncDispose).mockImplementation(() => {
            const closed = dispose();
            samples.push(
              closed.then(
                () => undefined,
                () => undefined,
              ),
            );
            return closed;
          });
          return opened;
        });
        // Observe completion, not results: the real consumer retains rejection.
        samples.push(
          pending.then(
            () => undefined,
            () => undefined,
          ),
        );
        return pending;
      });
    }
    const source = actualWatch(authority, { ...options, intervalMs: 2_147_483_647 });
    sources.push(source);
    sourceCreated?.(source);
    return source;
  });
  vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const onChange = vi.fn();
  const log = {
    warn: vi.fn((message: string) => ready.reject(new Error(message))),
    error: vi.fn((message: string) => ready.reject(new Error(message))),
  };
  const adapter = createConfigFileAdapter({
    path: configPath,
    includedPaths: includes,
    includeRoots: [sharedDir],
    onChange,
    onReady: () => ready.resolve(),
    log,
  });
  const settle = async () => {
    // Real guarded I/O must finish before advancing the next 50ms sample tick.
    for (let index = 0; index < 6; index++) {
      await vi.advanceTimersByTimeAsync(50);
      while (samples.length) {
        await Promise.all(samples.splice(0));
      }
      await vi.advanceTimersByTimeAsync(0);
    }
  };
  const reconcile = async () => {
    const results = await Promise.allSettled(
      sources
        .filter((source) => source.health().state === "ready")
        .map((source) => source.reconcile()),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ name: "AbortError" });
      }
    }
    await settle();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  };
  const replacing = () => {
    const next = createDeferred<observation.WatchSubscription>();
    sourceCreated = (source) => {
      sourceCreated = undefined;
      next.resolve(source);
    };
    return next.promise.then((source) => source.ready);
  };
  try {
    adapter.start();
    await ready.promise;
    await settle();
    onChange.mockClear();
    return { adapter, onChange, reconcile, replacing, settle, configDir, sharedDir };
  } catch (error) {
    try {
      await adapter.stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Config fixture startup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}

it("keeps accepted files while observing rejected exact entries and retires them only on acceptance", async () => {
  await withTestDir({ prefix: "config-scope-lifecycle-" }, async (directory) => {
    const accepted = path.join(directory, "config", "accepted.json");
    await fs.mkdir(path.dirname(accepted), { recursive: true });
    await fs.writeFile(accepted, "before");
    const f = await fixture(directory, [accepted]);
    try {
      const rejected = path.join(f.configDir, "rejected");
      await fs.mkdir(rejected);
      let ready = f.replacing();
      await f.adapter.observePaths([rejected]);
      await ready;
      await f.settle();
      f.onChange.mockClear();
      await fs.writeFile(path.join(rejected, "child.json"), "not config");
      await f.reconcile();
      expect(f.onChange).not.toHaveBeenCalled();
      await fs.writeFile(accepted, "accepted source still watched");
      await f.reconcile();
      expect(f.onChange).toHaveBeenCalledOnce();
      f.onChange.mockClear();
      await fs.rm(rejected, { recursive: true });
      await fs.writeFile(rejected, "repaired exact entry");
      await f.reconcile();
      expect(f.onChange).toHaveBeenCalledOnce();
      const replacement = path.join(f.sharedDir, "replacement.json");
      await fs.writeFile(replacement, "replacement");
      ready = f.replacing();
      await f.adapter.acceptPaths([replacement]);
      await ready;
      await f.settle();
      f.onChange.mockClear();
      await fs.writeFile(accepted, "retired accepted path");
      await fs.writeFile(rejected, "retired rejected path");
      await f.reconcile();
      expect(f.onChange).not.toHaveBeenCalled();
      await fs.writeFile(replacement, "later independent edit");
      await f.reconcile();
      expect(f.onChange).toHaveBeenCalledOnce();
    } finally {
      await f.adapter.stop();
    }
  });
});

it("observes a rejected lexical link without following it, then observes a later edit after repair", async () => {
  await withTestDir({ prefix: "config-link-repair-" }, async (directory) => {
    const outside = path.join(directory, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "include.json"), "unadmitted");
    const f = await fixture(directory);
    try {
      const alias = path.join(f.configDir, "alias");
      await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
      const candidate = path.join(alias, "include.json");
      let ready = f.replacing();
      await f.adapter.observePaths([candidate]);
      await ready;
      await f.settle();
      f.onChange.mockClear();
      await fs.writeFile(path.join(outside, "include.json"), "outside edit must not be observed");
      await f.reconcile();
      expect(f.onChange).not.toHaveBeenCalled();
      ready = f.replacing();
      await fs.unlink(alias);
      await fs.mkdir(alias);
      await fs.writeFile(candidate, "repaired contained include");
      await f.reconcile();
      await ready;
      await f.settle();
      f.onChange.mockClear();
      await fs.writeFile(candidate, "later contained edit");
      await f.reconcile();
      expect(f.onChange).toHaveBeenCalledOnce();
    } finally {
      await f.adapter.stop();
    }
  });
});

it.each([true, false])(
  "observes canonical include edits through an aliased root (initially present: %s)",
  async (present) => {
    await withTestDir({ prefix: "config-canonical-include-handoff-" }, async (directory) => {
      const configDir = path.join(directory, "config");
      const canonicalRoot = path.join(directory, "shared-canonical");
      const aliasRoot = path.join(directory, "shared-alias");
      await Promise.all([configDir, canonicalRoot].map((dir) => fs.mkdir(dir)));
      await fs.symlink(canonicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
      const canonicalFile = path.join(canonicalRoot, "gateway.json");
      const lexicalFile = path.join(aliasRoot, "gateway.json");
      const configPath = path.join(configDir, "openclaw.json");
      if (present) {
        await fs.writeFile(canonicalFile, JSON.stringify({ mode: "local", port: 18889 }));
      }
      await fs.writeFile(
        configPath,
        JSON.stringify({ plugins: { enabled: false }, gateway: { $include: lexicalFile } }),
      );
      vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
      vi.stubEnv("CHOKIDAR_INTERVAL", "20");
      vi.stubEnv("OPENCLAW_INCLUDE_ROOTS", aliasRoot);
      const { createConfigIoContext } = await import("./io.context.js");
      const { readConfigFileSnapshotFromContext } = await import("./io.snapshot.js");
      const { createConfigSource } = await import("./source.js");
      const { clearPluginMetadataLifecycleCaches } =
        await import("../plugins/plugin-metadata-lifecycle.js");
      const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
      const context = createConfigIoContext({
        configPath,
        env: {
          HOME: directory,
          USERPROFILE: directory,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(directory, "state"),
          OPENCLAW_INCLUDE_ROOTS: aliasRoot,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          VITEST: "true",
        },
        homedir: () => directory,
        observe: false,
      });
      context.options.pluginValidation = "core-only";
      const readSnapshot = () => readConfigFileSnapshotFromContext(context);
      const initial = await readSnapshot();
      expect(initial.valid).toBe(present);
      // Successful guarded reads supply both paths. Missing includes have only
      // lexical repair provenance; their configured root still pins the alias.
      expect(initial.includedPaths).toContain(lexicalFile);
      if (present) {
        expect(initial.includedPaths).toContain(canonicalFile);
      } else {
        expect(initial.includedPaths).not.toContain(canonicalFile);
      }
      const ready = createDeferred();
      const changed = createDeferred();
      void changed.promise.catch(() => {});
      const source = createConfigSource({
        path: configPath,
        includedPaths: initial.includedPaths,
        readSnapshot,
        onReady: () => {
          // The real source owner reconciles its initial snapshot at readiness.
          void source.readSnapshot().then(() => ready.resolve(), ready.reject);
        },
        onObserved(snapshotObservation) {
          void source.readSnapshot(snapshotObservation).then((snapshot) => {
            if (snapshot.valid && snapshot.config.gateway?.port === 18890) {
              changed.resolve();
            }
          }, changed.reject);
        },
        log: {
          info() {},
          warn: (message) => ready.reject(new Error(message)),
          error: (message) => changed.reject(new Error(message)),
        },
      });
      const cleanup = async () => {
        changed.reject(new Error("Config source test retired"));
        await source.stop();
        clearPluginMetadataLifecycleCaches();
        closeOpenClawStateDatabaseForTest();
      };
      sourceCleanups.add(cleanup);
      try {
        source.start();
        await ready.promise;
        // Initial source reconciliation has finished before the independent edit.
        // The alias entry and primary config are unchanged. Only a canonical-file
        // observation can deliver this later edit; no manual reconcile/read helps it.
        await fs.writeFile(canonicalFile, JSON.stringify({ mode: "local", port: 18890 }));
        await changed.promise;
        expect(source.status()).toBe("active");
      } finally {
        await cleanup();
        sourceCleanups.delete(cleanup);
      }
    });
  },
);
