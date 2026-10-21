import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterAll, afterEach, expect, it, onTestFinished } from "vitest";
import { CliPluginInvocationResources } from "../cli/plugin-invocation-resources.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createPluginCliLoadSession,
  loadPluginCliDescriptors,
  loadPluginCliRegistrationEntriesWithDefaults,
  resolvePluginCliRootOwnerIds,
} from "./cli-registry-loader.js";
import { getPluginCliCommandDescriptors } from "./cli-root-descriptors.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache } from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { hasRetainedPluginRuntimeCloseError } from "./runtime-close-error.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

const countRegisterRuns = (markerPath: string) =>
  fs.readFileSync(markerPath, "utf8").split("\n").filter(Boolean).length;

function setupCountingCliPlugin(): { config: OpenClawConfig; markerPath: string } {
  useNoBundledPlugins();
  const markerPath = path.join(makePluginLoaderTempDir(), "register-runs.log");
  const { file } = writePlugin({
    id: "counting-cli",
    filename: "index.cjs",
    registration: `    require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, "register\\n");
    api.registerCli(() => {}, {
      commands: ["counting-cli"],
      descriptors: [{ name: "counting-cli", description: "Counting CLI", hasSubcommands: false }],
    });`,
  });
  return {
    config: { plugins: { load: { paths: [file] }, allow: ["counting-cli"] } },
    markerPath,
  };
}

it("registers an unrelated command without the Gateway's PostgreSQL credentials", async () => {
  const { config } = setupCountingCliPlugin();
  config.database = {
    engine: "postgres",
    postgres: { connection: { source: "env", provider: "default", id: "UNAVAILABLE_CLI_DSN" } },
  };
  const session = createPluginCliLoadSession();
  onTestFinished(() => session.close());
  const entries = await loadPluginCliRegistrationEntriesWithDefaults({
    cfg: config,
    env: {},
    primaryCommand: "counting-cli",
    session,
  });
  expect(entries.map((entry) => entry.pluginId)).toEqual(["counting-cli"]);
});

it.each([
  { outcome: "success", failure: undefined },
  { outcome: "Error", failure: { reason: new Error("Metadata cleanup failed") } },
  { outcome: "undefined", failure: { reason: undefined } },
])("joins CLI-owned source metadata disposal ($outcome)", async ({ failure }) => {
  useNoBundledPlugins();
  const { dir: pluginDir } = writePlugin({
    id: "owned-cli-metadata",
    filename: "index.cjs",
    body: 'throw new Error("Full runtime must not load for metadata help");',
  });
  writePlugin({
    id: "owned-cli-metadata",
    dir: pluginDir,
    filename: "cli-metadata.cjs",
    registration: `    api.registerCli(() => {}, {
      parentPath: ["nodes"],
      descriptors: [{ name: "owned-metadata", description: "Synthetic metadata", hasSubcommands: false }],
    });`,
  });
  const cache = createPluginCache();
  const resources = new CliPluginInvocationResources();
  const session = createPluginCliLoadSession(cache, { resources });
  const config: OpenClawConfig = {
    plugins: { allow: ["owned-cli-metadata"], load: { paths: [pluginDir] } },
  };
  const params = { cfg: config, env: process.env, primaryCommand: "nodes", session };
  const removalStarted = createDeferredCore();
  const finishRemoval = createDeferredCore();
  let instance: ReturnType<typeof getPluginInstance> = undefined;
  let releasing: Promise<void> | undefined;
  let disposals = 0;
  let siblingDisposals = 0;
  try {
    const entries = await loadPluginCliRegistrationEntriesWithDefaults(params, "metadata");
    expect(entries).toMatchObject([
      { parentPath: ["nodes"], placeholders: [{ name: "owned-metadata" }] },
    ]);
    const registry = await session.resolve(params).metadataRegistry;
    const record = registry?.plugins.find((entry) => entry.id === "owned-cli-metadata");
    instance = record && getPluginInstance(record);
    if (!instance) {
      throw new Error("Expected the registered metadata instance");
    }
    instance.onModuleDispose(() => {
      siblingDisposals++;
    });
    instance.onModuleDispose(async () => {
      disposals++;
      removalStarted.resolve();
      await finishRemoval.promise;
      if (failure) {
        // oxlint-disable-next-line typescript/only-throw-error -- Preserve disposal failures with literal undefined reasons.
        throw failure.reason;
      }
    });
    session.close();
    let released = false;
    releasing = resources.release();
    expect(resources.release()).toBe(releasing);
    const markReleased = <T>(result: T) => {
      released = true;
      return result;
    };
    const outcome = releasing.then(
      () => markReleased({ ok: true as const }),
      (error: unknown) => markReleased({ ok: false as const, error }),
    );
    await Promise.race([
      removalStarted.promise,
      outcome.then(() => {
        throw new Error("CLI invocation released before metadata disposal started");
      }),
    ]);
    expect([released, disposals, siblingDisposals]).toEqual([false, 1, 0]);
    finishRemoval.resolve();
    const result = await outcome;
    expect(result.ok).toBe(!failure);
    if (!result.ok && failure) {
      expect(hasRetainedPluginRuntimeCloseError(result.error)).toBe(false);
      expect(
        collectNestedErrorCandidates(result.error).some(
          (candidate) =>
            candidate instanceof AggregateError && candidate.errors.includes(failure.reason),
        ),
      ).toBe(true);
    }
    expect(resources.release()).toBe(releasing);
    expect([disposals, siblingDisposals]).toEqual([1, 1]);
  } finally {
    finishRemoval.resolve();
    session.close();
    await releasing?.catch(() => {});
    await resources.release().catch(() => {});
    await instance?.dispose();
    await retirePluginCache(cache);
  }
});

it("runs a legacy external plugin register once across CLI bootstrap stages", async () => {
  const { config, markerPath } = setupCountingCliPlugin();
  const session = createPluginCliLoadSession();
  onTestFinished(() => session.close());
  const params = { cfg: config, env: process.env, primaryCommand: "counting-cli", session };
  const ownerIds = await resolvePluginCliRootOwnerIds(params);
  const descriptors = await loadPluginCliDescriptors(params);
  expect(ownerIds).toEqual(["counting-cli"]);
  expect(descriptors.map((entry) => entry.name)).toContain("counting-cli");
  expect(countRegisterRuns(markerPath)).toBe(1);
});

it("keeps distinct load scopes on separate register passes", async () => {
  const { config, markerPath } = setupCountingCliPlugin();
  await loadPluginCliDescriptors({ cfg: config, env: process.env });
  await getPluginCliCommandDescriptors(config, process.env);
  expect(countRegisterRuns(markerPath)).toBe(2);
});
