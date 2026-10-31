import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { createConfigIO } from "../config/io.factory.js";
import { readCurrentConfigForPolicyCheck } from "../config/io.runtime.js";
import { formatConfigIssueSummary } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConfigSourceLocks } from "../config/write-lock.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { isPluginSourcePathInUse } from "./installed-plugin-package-ownership.js";
import { withPluginLifecycleLeaseAsync } from "./plugin-lifecycle-lease.js";

export async function withPluginSourceCleanup<T>(
  sourcePath: string,
  options: {
    configPath: string;
    env?: NodeJS.ProcessEnv;
    assertCurrent?: () => void;
    isReferenced?: (config: OpenClawConfig) => boolean;
  },
  run: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const env = options.env ?? process.env;
  const configPath = path.resolve(options.configPath);
  return await withPluginLifecycleLeaseAsync(options, async (lease) => {
    await lease.assertOwned();
    const readSources = async () => {
      lease.assertCurrent();
      const { snapshot, writeOptions } = await createConfigIO({
        configPath,
        env: cloneEnvWithPlatformSemantics(env),
        observe: false,
        pluginValidation: "core-only",
        shellEnvFallback: "defer",
        suppressFutureVersionWarning: true,
        logger: { warn: () => {}, error: () => {} },
      }).readConfigFileSnapshotForWrite();
      await lease.assertOwned();
      if (!snapshot.valid) {
        throw new Error(
          `Cannot remove plugin source with invalid config at ${configPath}: ${formatConfigIssueSummary(snapshot.issues)}`,
        );
      }
      const targets = Object.entries(writeOptions.includeFileTargetsForWrite ?? {}).flat();
      const sources = new Set(
        [configPath, resolvePathViaExistingAncestorSync(configPath), ...targets].map((source) =>
          path.resolve(source),
        ),
      );
      if (snapshot.includedPaths?.some((source) => !sources.has(path.resolve(source)))) {
        throw new Error(`Cannot lock every config source for plugin cleanup at ${configPath}`);
      }
      return [...sources].toSorted();
    };
    let sources = await readSources();
    for (;;) {
      const attempt = await withConfigSourceLocks(
        sources,
        async (assertCurrent) => {
          const currentSources = await readSources();
          assertCurrent();
          if (
            sources.length !== currentSources.length ||
            sources.some((source, index) => source !== currentSources[index])
          ) {
            return { kind: "retry" as const, sources: currentSources };
          }
          const assertCleanup = () => {
            assertCurrent();
            const config = readCurrentConfigForPolicyCheck({
              configPath,
              env,
            });
            const referenced = options.isReferenced
              ? options.isReferenced(config)
              : isPluginSourcePathInUse(sourcePath, config.plugins?.load?.paths ?? [], env);
            if (referenced) {
              throw new Error(
                `Plugin source is still referenced by config: ${sourcePath}. Remove the load-path reference and retry.`,
              );
            }
            assertCurrent();
          };
          await lease.assertOwned();
          assertCleanup();
          const result = await run(assertCleanup);
          assertCurrent();
          return { kind: "complete" as const, result };
        },
        env,
        lease.assertCurrent,
      );
      if (attempt.kind === "complete") {
        return attempt.result;
      }
      sources = attempt.sources;
    }
  });
}
