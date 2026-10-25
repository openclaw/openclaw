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
    ["stable", "path", ["index"]],
    ["dev", "npm", ["index"]],
    ["dev", "none", ["index"]],
    ["stable", "npm", ["one", "two"]],
  ] as const)("preserves explicit %s/%s ownership for %j", async (channel, source, entries) => {
    const root = fs.realpathSync(tempDirs.make("openclaw-cohort-linked-"));
    const multiple = entries.length > 1;
    const trackedPath = path.join(root, multiple ? "managed-task" : "bundled/llm-task");
    const linkedPath = path.join(root, "linked-task");
    for (const directory of [trackedPath, linkedPath]) {
      writePackage(directory, "llm-task", { entries: [...entries] });
    }
    const record: PluginInstallRecord = {
      source: source === "none" ? "npm" : source,
      spec: "@example/llm-task",
      ...(multiple ? {} : { sourcePath: linkedPath }),
      installPath:
        source === "npm" && channel === "dev"
          ? path.join(root, "missing-shadowed-package")
          : trackedPath,
    };
    const records = source === "none" ? {} : { "llm-task": record };
    const config = cohortConfig(records, {
      load: { paths: [linkedPath] },
      ...(multiple ? {} : { entries: { "llm-task": { enabled: true } } }),
    });
    const ids = entries.map((entry) => (multiple ? `llm-task/${entry}` : "llm-task"));
    await withUnavailableRegistry(root, async (env, requests) => {
      await withCohort(
        { config, channel, coreVersion: "2026.9.4", timeoutMs: 60_000, env },
        async (result) => {
          expect(requests()).toBe(0);
          expect(result.config).toEqual(config);
          expect(result).toMatchObject({
            changed: false,
            remainingMissingPayloads: [],
            repairOutcomes: [],
            sync: { summary: { errors: [], switchedToBundled: [] } },
            updateOutcomes: ids.map((pluginId) => ({
              pluginId,
              status: "skipped",
              code: "plugin-operator-managed",
              ...(source === "none"
                ? {}
                : {
                    shadowedInstallOwner: "llm-task",
                    shadowedInstallRecord: record,
                  }),
            })),
          });
          expect(result.updateOutcomes[0]?.message).toContain(
            "This copy was not updated; verify it against 2026.9.4 or remove it from plugins.load.paths",
          );
          if (source !== "none") {
            expect(result.updateOutcomes[0]?.message).toContain(
              `It shadows the ${source} install @example/llm-task at ${record.installPath}`,
            );
          }
          expect(await runActivePluginPayloadSmokeCheck({ cfg: config, records, env })).toEqual(
            emptyPayloadCheck,
          );
          const index = withPluginCache(createPluginCache(), () =>
            loadInstalledPluginIndex({ config, installRecords: records, env }),
          );
          const ownership = createInstalledPluginOwnershipResolver(index, env);
          for (const id of ids) {
            expect(index.plugins.find((plugin) => plugin.pluginId === id)?.rootDir).toBe(
              linkedPath,
            );
            expect(ownership.resolvePackage(id).ok).toBe(false);
            expect(ownership.resolveLifecycle(id).ok).toBe(false);
          }
          for (const directory of multiple ? [trackedPath, linkedPath] : [linkedPath]) {
            for (const entry of entries) {
              expectUnchangedModule(directory, entry);
            }
          }
        },
      );
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
