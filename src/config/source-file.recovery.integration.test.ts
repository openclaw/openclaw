import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import * as observation from "@openclaw/fs-safe/watch";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createConfigFileAdapter } from "./source-file.js";

// Copy the external ESM namespace so test instrumentation can wrap watch while
// integration cases still execute the installed implementation unchanged.
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  // Vitest importOriginal would evaluate watch in its module runner while Root
  // stays external, splitting fs-safe's private Root identity registry.
  return { ...createRequire(import.meta.url)("@openclaw/fs-safe/watch") };
});

afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const nativeSupported =
  process.platform === "linux" && !process.versions.bun && !process.versions.deno;

it.runIf(nativeSupported)(
  "joins a failed native observer, retries, and observes a real later edit",
  async () => {
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    await withTestDir({ prefix: "config-native-recovery-" }, async (directory) => {
      const configDir = path.join(directory, "config");
      const configPath = path.join(configDir, "openclaw.json");
      await fs.mkdir(configDir);
      await fs.writeFile(configPath, "before");
      const admitted = await root(directory, { symlinks: "reject" });
      const failed = createDeferred();
      const recovered = createDeferred();
      void recovered.promise.catch(() => {});
      const later = createDeferred();
      const subscriptions: observation.WatchSubscription[] = [];
      const actualWatch = observation.watch;
      vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
        const subscription = actualWatch(authority, { ...options, intervalMs: 2_147_483_647 });
        subscriptions.push(subscription);
        if (subscriptions.length === 2) {
          void subscription.ready.then(recovered.resolve, recovered.reject);
        }
        return subscription;
      });
      let injectionPending = true;
      // oxlint-disable-next-line typescript/unbound-method -- Every invocation below supplies the intercepted Worker receiver via .call/.apply.
      const postMessage = Worker.prototype.postMessage;
      vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        ...args: Parameters<Worker["postMessage"]>
      ) {
        const message: unknown = args[0];
        if (
          injectionPending &&
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "add" &&
          "path" in message &&
          typeof message.path === "string"
        ) {
          injectionPending = false;
          // The qualified backend registers descriptor-bound /proc paths, not
          // the lexical Root. Fault this owner's first add with an actual missing
          // path without replacing the pinned authority needed by the later retry.
          return postMessage.call(
            this,
            { ...message, path: path.join(admitted.rootReal, "absent-registration") },
            args[1],
          );
        }
        return postMessage.apply(this, args);
      });
      const adapter = createConfigFileAdapter({
        path: configPath,
        onChange() {
          // The caller reads its known admitted source, never a backend filename.
          void admitted.readText("config/openclaw.json", { symlinks: "reject" }).then(
            (text) => {
              if (text === "later") {
                later.resolve();
              }
            },
            () => {},
          );
        },
        log: {
          warn: (message) => {
            if (message.includes("re-creating watcher")) {
              if (injectionPending) {
                failed.reject(new Error(message));
              } else {
                failed.resolve();
              }
            }
          },
          error: recovered.reject,
        },
      });
      try {
        adapter.start();
        await failed.promise;
        __setFsSafeTestHooksForTest();
        expect(injectionPending).toBe(false);
        await fs.writeFile(configPath, "recovered");
        await recovered.promise;
        expect(subscriptions).toHaveLength(2);
        const previous = subscriptions[0]!;
        expect(previous.health().failure?.operation).toBe("watch");
        await expect(previous.close()).resolves.toBeUndefined();
        expect(previous.health().workers).toBe(0);
        await fs.writeFile(configPath, "later");
        await later.promise;
        expect(adapter.status()).toBe("active");
      } finally {
        __setFsSafeTestHooksForTest();
        await adapter.stop();
      }
    });
  },
);

it.runIf(nativeSupported)(
  "never rearms after a real worker termination failure, even with late retry delivery",
  async () => {
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    await withTestDir({ prefix: "config-native-close-failure-" }, async (directory) => {
      const configPath = path.join(directory, "openclaw.json");
      await fs.writeFile(configPath, "before");
      const ready = createDeferred();
      const failedClose = createDeferred();
      const watch = vi.spyOn(observation, "watch");
      const adapter = createConfigFileAdapter({
        path: configPath,
        onChange() {},
        onReady: () => ready.resolve(),
        log: {
          warn: (message) => ready.reject(new Error(message)),
          error: (message) => {
            ready.reject(new Error(message));
            failedClose.resolve();
          },
        },
      });
      let termination: import("vitest").MockInstance<Worker["terminate"]> | undefined;
      const owned = new Set<Worker>();
      try {
        adapter.start();
        await ready.promise;
        const subscription = watch.mock.results[0]?.value;
        if (!subscription) {
          throw new Error("config observation was not admitted");
        }
        const failure = new Error("injected native worker termination failure");
        termination = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (
          this: Worker,
        ) {
          owned.add(this);
          return Promise.reject(failure);
        });
        const timers = vi.spyOn(globalThis, "setTimeout");
        __setFsSafeTestHooksForTest({
          async beforeWatchRegistration() {
            throw new Error("scan unavailable");
          },
        });
        await expect(subscription.reconcile()).rejects.toThrow();
        await failedClose.promise;
        expect(adapter.status()).toBe("disabled");
        expect(owned.size).toBe(1);
        // A timer already queued before failure cannot acquire a replacement.
        const retry = timers.mock.calls.find(([, delay]) => delay === 500)?.[0];
        expect(retry).toBeTypeOf("function");
        if (typeof retry === "function") {
          retry();
        }
        await expect(adapter.stop()).rejects.toThrow("Config watcher shutdown failed");
        expect(watch).toHaveBeenCalledOnce();
      } finally {
        __setFsSafeTestHooksForTest();
        termination?.mockRestore();
        // These are exclusively the worker instances whose retirement this test faulted.
        await Promise.all([...owned].map((worker) => worker.terminate()));
        await adapter.stop().catch(() => {});
      }
    });
  },
);

it.runIf(nativeSupported).each(["stop", "replace"] as const)(
  "joins and fences a held native Config scan during %s",
  async (ending) => {
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    await withTestDir({ prefix: "config-held-scan-" }, async (directory) => {
      const configPath = path.join(directory, "openclaw.json");
      const include = path.join(directory, "include.json");
      await fs.writeFile(configPath, "before");
      await fs.writeFile(include, "{}");
      const ready = createDeferred();
      const entered = createDeferred();
      const release = createDeferred();
      const closeCalled = createDeferred();
      const replacementReady = createDeferred();
      const later = createDeferred();
      const subscriptions: Array<{
        root: Awaited<ReturnType<typeof root>>;
        subscription: observation.WatchSubscription;
      }> = [];
      const actualWatch = observation.watch;
      vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
        const subscription = actualWatch(authority, { ...options, intervalMs: 2_147_483_647 });
        subscriptions.push({ root: authority, subscription });
        if (subscriptions.length === 2) {
          void subscription.ready.then(replacementReady.resolve, replacementReady.reject);
        }
        return subscription;
      });
      const reads: Promise<void>[] = [];
      const changed = vi.fn(() => {
        reads.push(
          fs.readFile(configPath, "utf8").then((value) => {
            if (value === "later") {
              later.resolve();
            }
          }, later.reject),
        );
      });
      const adapter = createConfigFileAdapter({
        path: configPath,
        onChange: changed,
        onReady: () => ready.resolve(),
        log: { warn: ready.reject, error: ready.reject },
      });
      let scan: Promise<unknown> | undefined;
      let retired: Promise<void> | undefined;
      try {
        adapter.start();
        await ready.promise;
        const old = subscriptions[0]!;
        const close = old.subscription.close.bind(old.subscription);
        vi.spyOn(old.subscription, "close").mockImplementation(() => {
          closeCalled.resolve();
          return close();
        });
        let held = false;
        __setFsSafeTestHooksForTest({
          async beforeWatchRegistration() {
            if (held) {
              return;
            }
            held = true;
            entered.resolve();
            await release.promise;
          },
        });
        scan = old.subscription.reconcile().catch((error: unknown) => error);
        await entered.promise;
        await fs.writeFile(configPath, "during retired scan");
        let joined = false;
        retired = (ending === "stop" ? adapter.stop() : adapter.acceptPaths([include])).then(() => {
          joined = true;
        });
        await closeCalled.promise;
        expect(joined).toBe(false);
        expect(changed).not.toHaveBeenCalled();
        __setFsSafeTestHooksForTest();
        release.resolve();
        await Promise.all([scan, retired]);
        expect(old.subscription.health()).toMatchObject({
          state: "closed",
          workers: 0,
          observedDirectories: 0,
        });
        if (ending === "replace") {
          await replacementReady.promise;
          expect(subscriptions).toHaveLength(2);
          expect(subscriptions[1]!.root).toBe(old.root);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(changed).toHaveBeenCalledOnce();
          await Promise.all(reads);
          await fs.writeFile(configPath, "later");
          await later.promise;
        } else {
          expect(changed).not.toHaveBeenCalled();
        }
      } finally {
        __setFsSafeTestHooksForTest();
        release.resolve();
        await Promise.allSettled([scan, retired]);
        await adapter.stop();
        await Promise.all(reads);
      }
    });
  },
);
