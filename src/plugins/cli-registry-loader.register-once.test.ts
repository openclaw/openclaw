// Pins one plugin register execution per CLI invocation across independent bootstrap stages.
import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterAll, afterEach, describe, expect, it, onTestFinished } from "vitest";
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

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

function countRegisterRuns(markerPath: string): number {
  return fs.existsSync(markerPath)
    ? fs.readFileSync(markerPath, "utf8").split("\n").filter(Boolean).length
    : 0;
}

function setupCountingCliPlugin(): { config: OpenClawConfig; markerPath: string } {
  useNoBundledPlugins();
  const pluginDir = makePluginLoaderTempDir();
  const markerPath = path.join(makePluginLoaderTempDir(), "register-runs.log");
  writePlugin({
    id: "counting-cli",
    dir: pluginDir,
    filename: "index.cjs",
    body: `const fs = require("node:fs");
module.exports = {
  id: "counting-cli",
  register(api) {
    fs.appendFileSync(${JSON.stringify(markerPath)}, "register\\n");
    api.registerCli(() => {}, {
      commands: ["counting-cli"],
      descriptors: [
        { name: "counting-cli", description: "Counting CLI", hasSubcommands: false },
      ],
    });
  },
};`,
  });
  return {
    config: {
      plugins: {
        load: { paths: [path.join(pluginDir, "index.cjs")] },
        allow: ["counting-cli"],
      },
    } as OpenClawConfig,
    markerPath,
  };
}

describe("plugin CLI metadata registration", () => {
  it.each([
    { outcome: "success", failure: undefined },
    { outcome: "Error", failure: { reason: new Error("Metadata cleanup failed") } },
    { outcome: "undefined", failure: { reason: undefined } },
  ])("joins CLI-owned source metadata disposal ($outcome)", async ({ failure }) => {
    useNoBundledPlugins();
    const pluginDir = makePluginLoaderTempDir();
    writePlugin({
      id: "owned-cli-metadata",
      dir: pluginDir,
      filename: "index.cjs",
      body: 'throw new Error("Full runtime must not load for metadata help");',
    });
    fs.writeFileSync(
      path.join(pluginDir, "cli-metadata.cjs"),
      `module.exports = {
  id: "owned-cli-metadata",
  register(api) {
    api.registerCli(() => {}, {
      parentPath: ["nodes"],
      descriptors: [{ name: "owned-metadata", description: "Synthetic metadata", hasSubcommands: false }],
    });
  },
};`,
    );
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
      expect(entries.map((entry) => entry.parentPath)).toEqual([["nodes"]]);
      expect(entries.flatMap((entry) => entry.placeholders.map((item) => item.name))).toEqual([
        "owned-metadata",
      ]);
      const registry = await session.resolve(params).metadataRegistry;
      const record = registry?.plugins.find((entry) => entry.id === "owned-cli-metadata");
      if (!record) {
        throw new Error("Expected the real source metadata registration");
      }
      instance = getPluginInstance(record);
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
      const outcome = releasing.then(
        () => {
          released = true;
          return { ok: true as const };
        },
        (error: unknown) => {
          released = true;
          return { ok: false as const, error };
        },
      );
      await Promise.race([
        removalStarted.promise,
        outcome.then(() => {
          throw new Error("CLI invocation released before metadata disposal started");
        }),
      ]);
      expect(released).toBe(false);
      expect(disposals).toBe(1);
      expect(siblingDisposals).toBe(0);
      finishRemoval.resolve();
      const result = await outcome;
      if (failure) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(hasRetainedPluginRuntimeCloseError(result.error)).toBe(true);
          expect(
            collectNestedErrorCandidates(result.error).some(
              (candidate) =>
                candidate instanceof AggregateError && candidate.errors.includes(failure.reason),
            ),
          ).toBe(true);
        }
      } else {
        expect(result).toEqual({ ok: true });
      }
      expect(resources.release()).toBe(releasing);
      expect(disposals).toBe(1);
      expect(siblingDisposals).toBe(1);
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
    // Stage order mirrors one `openclaw counting-cli --help` invocation: the unowned-primary
    // guard resolves plugin CLI root ownership, then command registration resolves descriptors
    // for the same primary. The CLI carries one preparation session through both stages.
    const ownerIds = await resolvePluginCliRootOwnerIds({
      cfg: config,
      env: process.env,
      primaryCommand: "counting-cli",
      session,
    });
    const descriptors = await loadPluginCliDescriptors({
      cfg: config,
      env: process.env,
      primaryCommand: "counting-cli",
      session,
    });

    expect(ownerIds).toEqual(["counting-cli"]);
    expect(descriptors.map((entry) => entry.name)).toContain("counting-cli");
    expect(countRegisterRuns(markerPath)).toBe(1);
  });

  it("keeps distinct load scopes on separate register passes", async () => {
    const { config, markerPath } = setupCountingCliPlugin();
    // Root help executes only the legacy external plugins it could not read from manifests, so
    // its narrower scope must not be served the full-scope registry (or vice versa).
    await loadPluginCliDescriptors({ cfg: config, env: process.env });
    await getPluginCliCommandDescriptors(config, process.env);

    expect(countRegisterRuns(markerPath)).toBe(2);
  });
});
