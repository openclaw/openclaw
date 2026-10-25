import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runActivePluginPayloadSmokeCheck } from "./active-payload-verification.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { convergePluginReleaseCohort } from "./update-cohort.js";
import {
  cohortConfig,
  createCohortEnv as fixtureEnv,
  writeCohortPackage as writePackage,
} from "./update-cohort.test-support.js";

type CohortParams = Parameters<typeof convergePluginReleaseCohort>[0];
async function withCohort(
  params: CohortParams & { env: NodeJS.ProcessEnv },
  check: (result: Awaited<ReturnType<typeof convergePluginReleaseCohort>>) => Promise<void>,
) {
  await withEnvAsync(params.env, async () => {
    const result = await withPluginCache(createPluginCache(), () =>
      convergePluginReleaseCohort(params),
    );
    await check(result);
  });
}

const emptyPayloadCheck = { checked: [], failures: [] };
const emptyModule = "module.exports = {};\n";
function expectUnchangedModule(directory: string, entry = "index") {
  expect(fs.readFileSync(path.join(directory, `${entry}.js`), "utf8")).toBe(emptyModule);
}

async function withUnavailableRegistry(
  root: string,
  check: (env: NodeJS.ProcessEnv, requests: () => number) => Promise<void>,
) {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests += 1;
      response.writeHead(404);
      response.end("Fixture package is unavailable");
    },
    (registry) => check(fixtureEnv(root, registry), () => requests),
  );
}

describe("plugin release cohort real synchronization", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    { channel: "stable", explicit: true, source: "path" },
    { channel: "dev", explicit: true, source: "path" },
    { channel: "dev", explicit: false, source: "path" },
    { channel: "stable", explicit: true, source: "npm" },
    { channel: "dev", explicit: true, source: "npm" },
    { channel: "stable", explicit: true, source: "none" },
    { channel: "dev", explicit: true, source: "none" },
  ] as const)(
    "preserves package ownership boundaries for $source on $channel (explicit link: $explicit)",
    async ({ channel, explicit, source }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-cohort-linked-"));
      const bundledPath = path.join(root, "bundled", "llm-task");
      const linkedPath = path.join(root, "linked-task");
      for (const directory of [bundledPath, linkedPath]) {
        writePackage(directory, "llm-task");
      }
      const record: PluginInstallRecord = {
        source: source === "none" ? "npm" : source,
        spec: "@example/llm-task",
        sourcePath: linkedPath,
        // Retained package metadata disagrees with the explicitly selected source.
        installPath:
          source === "npm" && channel === "dev"
            ? path.join(root, "missing-shadowed-package")
            : bundledPath,
      };
      const config = cohortConfig(source === "none" ? {} : { "llm-task": record }, {
        load: { paths: explicit ? [linkedPath] : [] },
        entries: { "llm-task": { enabled: true } },
      });
      const env = fixtureEnv(root);
      await withCohort(
        { config, channel, coreVersion: "2026.9.4", timeoutMs: 60_000, env },
        async (result) => {
          expect(result).toMatchObject({ remainingMissingPayloads: [] });
          expect(result.sync.summary).toMatchObject({
            errors: [],
            warnings: [],
            switchedToBundled: explicit ? [] : ["llm-task"],
          });
          expect(result.config.plugins?.installs?.["llm-task"]).toEqual(
            source === "none"
              ? undefined
              : explicit
                ? record
                : {
                    ...record,
                    sourcePath: bundledPath,
                    version: undefined,
                    installedAt: expect.any(String),
                  },
          );
          expect(result.config.plugins?.load?.paths).toEqual([explicit ? linkedPath : bundledPath]);
          if (explicit) {
            expect(result).toMatchObject({ changed: false, repairOutcomes: [] });
            expect(result.updateOutcomes).toEqual([
              expect.objectContaining({
                pluginId: "llm-task",
                status: "skipped",
                code: "plugin-operator-managed",
                rootDir: linkedPath,
                source: path.join(linkedPath, "index.js"),
                ...(source === "none" ? {} : { shadowedInstallRecord: record }),
              }),
            ]);
            expect(result.updateOutcomes[0]?.message).toContain(
              "This copy was not updated; verify it against 2026.9.4 or remove it from plugins.load.paths",
            );
            if (source !== "none") {
              expect(result.updateOutcomes[0]?.message).toContain(
                `It shadows the ${source} install @example/llm-task at ${record.installPath}`,
              );
            }
            expect(
              await runActivePluginPayloadSmokeCheck({
                cfg: result.config,
                records: result.config.plugins?.installs ?? {},
                env,
              }),
            ).toEqual(emptyPayloadCheck);
          }
          const selectedIndex = withPluginCache(createPluginCache(), () =>
            loadInstalledPluginIndex({
              config: result.config,
              installRecords: result.config.plugins?.installs ?? {},
              env,
            }),
          );
          const selected = selectedIndex.plugins.find((plugin) => plugin.pluginId === "llm-task");
          expect(selected?.rootDir).toBe(explicit ? linkedPath : bundledPath);
          if (explicit) {
            const ownership = createInstalledPluginOwnershipResolver(selectedIndex, env);
            expect(ownership.resolvePackage("llm-task").ok).toBe(false);
            expect(ownership.resolveLifecycle("llm-task").ok).toBe(false);
          }
          expectUnchangedModule(linkedPath);
        },
      );
    },
  );
  it("retains local package children and their shadowed npm owner without registry work", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-cohort-local-children-"));
    const managedPath = path.join(root, "managed-pack");
    const localPath = path.join(root, "local-pack");
    for (const directory of [managedPath, localPath]) {
      writePackage(directory, "pack", { entries: ["one", "two"] });
    }
    const records = {
      pack: { source: "npm", spec: "@example/pack", installPath: managedPath },
    } satisfies Record<string, PluginInstallRecord>;
    const config = cohortConfig(records, { load: { paths: [localPath] } });
    await withUnavailableRegistry(root, async (env, requests) => {
      await withCohort({ config, channel: "stable", timeoutMs: 10_000, env }, async (result) => {
        expect(requests()).toBe(0);
        expect(result.config).toEqual(config);
        expect(result.updateOutcomes).toEqual(
          ["pack/one", "pack/two"].map((pluginId) =>
            expect.objectContaining({
              pluginId,
              code: "plugin-operator-managed",
              shadowedInstallOwner: "pack",
              shadowedInstallRecord: records.pack,
            }),
          ),
        );
        expect(await runActivePluginPayloadSmokeCheck({ cfg: config, records, env })).toEqual(
          emptyPayloadCheck,
        );
        for (const directory of [managedPath, localPath]) {
          for (const entry of ["one", "two"]) {
            expectUnchangedModule(directory, entry);
          }
        }
      });
    });
  });
  it.each(["none", "missing", "installed"] as const)(
    "keeps current payloads after a dev switch when a failing npm sibling is %s",
    async (sibling) => {
      const hasSibling = sibling !== "none";
      const root = fs.realpathSync(tempDirs.make("openclaw-cohort-dev"));
      const bundledPath = path.join(root, "bundled", "cohort");
      const oldPath = path.join(root, "removed-npm-package");
      const siblingPath = path.join(root, "sibling-package");
      writePackage(bundledPath, "cohort");
      if (sibling === "installed") {
        writePackage(siblingPath, "broken", { source: "module.exports = { previous: true };\n" });
      }
      const records: Record<string, PluginInstallRecord> = {
        cohort: { source: "npm", spec: "@example/cohort", installPath: oldPath },
      };
      if (hasSibling) {
        records.broken = {
          source: "npm",
          spec: "@example/broken",
          installPath: siblingPath,
          ...(sibling === "installed" ? { version: "1.0.0" } : {}),
        };
      }
      const config = cohortConfig(records, {
        entries: Object.fromEntries(Object.keys(records).map((id) => [id, { enabled: true }])),
      });
      await withUnavailableRegistry(root, async (env, registryRequests) => {
        await withCohort({ config, channel: "dev", timeoutMs: 60_000, env }, async (result) => {
          expect(result.sync.summary.switchedToBundled).toEqual(["cohort"]);
          expect(result.config.plugins?.installs?.cohort).toMatchObject({
            source: "path",
            installPath: bundledPath,
          });
          for (const payloads of [result.missingPayloads, result.remainingMissingPayloads]) {
            expect(payloads.map((entry) => entry.pluginId)).toEqual(
              sibling === "missing" ? ["broken"] : [],
            );
          }
          if (hasSibling) {
            expect(registryRequests()).toBeGreaterThan(0);
            expect(
              [...result.repairOutcomes, ...result.updateOutcomes].filter(
                (outcome) => outcome.pluginId === "broken",
              ),
            ).toEqual([
              expect.objectContaining({
                pluginId: "broken",
                status: sibling === "installed" ? "unchanged" : "error",
                ...(sibling === "installed"
                  ? { code: "plugin-target-unavailable", currentVersion: "1.0.0" }
                  : {}),
              }),
            ]);
            expect(result.config.plugins?.entries?.broken?.enabled).toBe(true);
            expect(result.config.plugins?.installs?.broken).toEqual(records.broken);
            if (sibling === "installed") {
              expect(fs.readFileSync(path.join(siblingPath, "index.js"), "utf8")).toBe(
                "module.exports = { previous: true };\n",
              );
            }
          } else {
            expect(registryRequests()).toBe(0);
            expect(result.repairOutcomes).toEqual([]);
          }
        });
      });
    },
  );
});
