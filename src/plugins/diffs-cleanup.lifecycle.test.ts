import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { registerTestPlugin } from "../plugin-sdk/plugin-test-contracts.js";
import { createPluginRuntimeMock } from "../plugin-sdk/plugin-test-runtime.js";
import * as blobs from "../plugin-state/plugin-blob-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { PluginInstance } from "./plugin-instance.js";
import { createPluginRegistry } from "./registry.js";
import { startPluginServices, type PluginServicesHandle } from "./services.test-support.js";
import { createPluginRecord as pluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginDefinition } from "./types.js";

const temporaryRoot = vi.hoisted(() => ({ value: "" }));
const id = "diffs";
vi.mock("../infra/tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: () => temporaryRoot.value,
}));
vi.mock("../plugin-state/plugin-blob-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin-state/plugin-blob-store.js")>();
  return { ...actual, createPluginBlobStore: vi.fn(actual.createPluginBlobStore) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "keeps a registered Diffs tool owned through late quota cleanup after service stop (sibling failure: %s)",
  async (failSibling) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-diffs-lifecycle-"));
    const releaseQuota = createDeferredCore();
    const releaseRemoval = createDeferredCore();
    const removalEntered = createDeferredCore();
    const removals: Promise<unknown>[] = [];
    let instance: PluginInstance | undefined;
    let services: PluginServicesHandle | undefined;
    let invocationSettlement: Promise<unknown> | undefined;
    let draining: ReturnType<PluginInstance["drain"]> | undefined;
    try {
      temporaryRoot.value = root;
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const { default: diffsPlugin } = await loadBundledPluginFacade<{
        default: OpenClawPluginDefinition;
      }>({ pluginId: id, artifactBasename: "index.js" });
      assert(diffsPlugin.register, "Diffs has no plugin registration entry point");
      const config = {};
      const builder = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: createPluginRuntimeMock({ config: { current: () => config } }),
      });
      const record = pluginRecord({ id, origin: "bundled", contracts: { tools: [id] } });
      instance = new PluginInstance(id, { record, registry: builder.registry });
      registerTestPlugin({ registry: builder, config, record, register: diffsPlugin.register });
      const opened = vi.mocked(blobs.createPluginBlobStore).mock.results.at(-1);
      assert(opened?.type === "return", "Diffs did not open its registered Blob store");
      const store = opened.value;
      services = await startPluginServices({ registry: builder.registry, config });
      // Establish the real store workers before testing the host's fixed drain deadline.
      await store.register("fixture-startup", new Uint8Array(), {});
      expect(await store.lookup("fixture-startup")).not.toBeNull();
      await store.delete("fixture-startup");
      const tool = builder.registry.tools[0]?.factory({ config });
      assert(tool && !Array.isArray(tool), "Diffs did not register its tool");
      const heldId = "a".repeat(20);
      const failedId = "b".repeat(20);
      const filesRoot = path.join(root, "openclaw-diffs");
      const heldDirectory = path.join(filesRoot, heldId);
      for (const artifactId of [heldId, failedId]) {
        const directory = path.join(filesRoot, artifactId);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "preview.png"), artifactId);
        const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
        await fs.utimes(directory, old, old);
      }
      const writeEntered = createDeferredCore();
      const siblingFinished = createDeferredCore();
      const failure = new Error("fixture Blob lookup failed");
      vi.spyOn(store, "registerIfAbsentWithReceipt").mockImplementationOnce(async () => {
        writeEntered.resolve();
        await releaseQuota.promise;
        throw Object.assign(new Error("quota reached"), { code: "PLUGIN_BLOB_LIMIT_EXCEEDED" });
      });
      const lookup = store.lookup.bind(store);
      vi.spyOn(store, "lookup").mockImplementation(async (key) => {
        if (key === failedId) {
          await removalEntered.promise;
          siblingFinished.resolve();
          if (failSibling) {
            throw failure;
          }
        }
        return await lookup(key);
      });
      const remove = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation((target, options) => {
        const pending = (async () => {
          if (target === heldDirectory) {
            removalEntered.resolve();
            await releaseRemoval.promise;
          }
          return await remove(target, options);
        })();
        removals.push(pending);
        return pending;
      });
      const settled = { invocation: false, drain: false };
      const invocation = tool.execute("cleanup", { before: "a\n", after: "b\n", mode: "view" });
      const settle = <T>(value: T, error?: unknown) => {
        settled.invocation = true;
        return { value, error };
      };
      const result = invocation.then(
        (value) => settle(value),
        (error: unknown) => settle(undefined, error),
      );
      invocationSettlement = result;
      const beforeSettlement = (gate: Promise<void>) =>
        awaitGateBeforeSettlement(gate, result, "Diffs settled before its fixture gate");
      await beforeSettlement(writeEntered.promise);
      // The service stops background sweeps; the accepted tool still owns its late work.
      await services.stop();
      draining = instance.drain().then((value) => {
        settled.drain = true;
        return value;
      });
      releaseQuota.resolve();
      await beforeSettlement(siblingFinished.promise);
      await setImmediate();
      expect(settled).toEqual({ invocation: false, drain: false });
      expect(await fs.readFile(path.join(heldDirectory, "preview.png"), "utf8")).toBe(heldId);
      releaseRemoval.resolve();
      const outcome = await result;
      await Promise.allSettled(removals);
      expect(await draining).toEqual({ errors: [] });
      expect(await fs.readdir(filesRoot)).toEqual(failSibling ? [failedId] : []);
      expect(outcome.error).toBe(failSibling ? failure : undefined);
      if (!failSibling) {
        expect(outcome.value?.details).toMatchObject({ changed: true });
        expect(await store.entries()).toHaveLength(1);
      }
    } finally {
      releaseQuota.resolve();
      releaseRemoval.resolve();
      removalEntered.resolve();
      await invocationSettlement;
      await Promise.allSettled(removals);
      await draining;
      await services?.stop();
      await instance?.dispose();
      await closeOpenClawStateDatabaseAsync();
      blobs.resetPluginBlobStoreForTests();
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
