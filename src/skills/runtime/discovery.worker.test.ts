import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { writePersistedInstalledPluginIndex } from "../../plugins/installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "../../plugins/installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { writeRegistryPackagePlugin } from "../../plugins/test-helpers/plugin-registry-snapshot.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { pinConfigDir } from "../../utils.js";
import { mergeSkillRecords } from "../loading/skill-precedence.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  captureSkillsDiscoveryEnvironment,
  type SkillsDiscoveryInput,
  type SkillsDiscoveryOutput,
} from "./discovery-worker-contract.js";

const worker = vi.hoisted(() => ({
  handle: vi.fn<(input: unknown) => SkillsDiscoveryOutput | Promise<SkillsDiscoveryOutput>>(),
}));
vi.mock("../../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/worker-task-server.js")>()),
  serveWorkerTasks: (handler: (input: unknown) => SkillsDiscoveryOutput) => {
    worker.handle.mockImplementation(handler);
  },
}));
import "./discovery.worker.js";

const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    pinConfigDir();
    cleanup();
  }),
);

it("shares one installed-index read across workspaces and observes writes on the next scan", async () => {
  const root = temporary.make("skills-scan-inventory-");
  const stateDir = path.join(root, "state");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  pinConfigDir();
  const environment = captureSkillsDiscoveryEnvironment();
  const pluginRoot = path.join(root, "plugin");
  const workspaces = [path.join(root, "first-workspace"), path.join(root, "second-workspace")];
  const config: OpenClawConfig = {
    plugins: { load: { paths: [pluginRoot] }, entries: { fixture: { enabled: true } } },
  };
  writeRegistryPackagePlugin(pluginRoot, { pluginId: "fixture" });
  for (const [index, workspaceDir] of workspaces.entries()) {
    await writeSkill({
      dir: path.join(workspaceDir, "skills", `local-${index}`),
      name: `local-${index}`,
      description: `Workspace ${index}`,
    });
  }
  const publishPlugin = async (name: string) => {
    await writeSkill({ dir: path.join(pluginRoot, name), name, description: name });
    await fs.writeFile(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({ id: "fixture", configSchema: { type: "object" }, skills: [name] }),
    );
    const index = withPluginCache(createPluginCache(), () =>
      loadInstalledPluginIndex({ config, env: process.env }),
    );
    await writePersistedInstalledPluginIndex(index, { env: process.env });
  };
  await publishPlugin("original");
  const request: SkillsDiscoveryInput = {
    kind: "scan",
    path: process.env.PATH,
    requests: workspaces.map((workspaceDir) => ({
      key: workspaceDir,
      environment,
      selection: {
        kind: "planned",
        plan: {
          input: {
            workspaceDir,
            environment,
            acpRuntimeAvailable: false,
            options: {
              config,
              bundledSkillsDir: "",
              managedSkillsDir: path.join(stateDir, "skills"),
              pluginSkillsDir: path.join(stateDir, "plugin-skills"),
            },
          },
        },
        request: {
          limits: resolveSkillDiscoveryLimits(),
          additionalBins: [],
        },
      },
    })),
  };
  const scan = async (pluginName: string) => {
    const observed = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      const result = await worker.handle(structuredClone(request));
      if (result.kind !== "scan") {
        throw new Error("Expected scan results");
      }
      expect(
        result.results.map(({ key, sources }) =>
          mergeSkillRecords(sources.entries, key)
            .map(({ skill }) => skill.name)
            .toSorted(),
        ),
      ).toEqual(workspaces.map((_, index) => [`local-${index}`, pluginName].toSorted()));
      expect(
        observed.queries.filter((sql) =>
          /^select "state_key", "value_json" from "config_machine_state"/i.test(sql),
        ),
      ).toHaveLength(1);
    } finally {
      observed.restore();
    }
  };
  await scan("original");
  await publishPlugin("successor");
  await scan("successor");
});
