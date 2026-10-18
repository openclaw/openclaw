import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as boundaryFileRead from "../../infra/boundary-file-read.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { setGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { writePersistedInstalledPluginIndex } from "../../plugins/installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "../../plugins/installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { writeRegistryPackagePlugin } from "../../plugins/test-helpers/plugin-registry-snapshot.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { pinConfigDir } from "../../utils.js";
import { mergeSkillRecords } from "../loading/skill-precedence.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import type { WorkspaceSkillSource } from "../loading/workspace-skill-sources.types.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillEntry } from "../types.js";
import {
  captureSkillsDiscoveryEnvironment,
  type SkillsDiscoveryInput,
  type SkillsDiscoveryOutput,
} from "./discovery-worker-contract.js";
import { captureSkillsSourcePlanInput } from "./discovery-worker-input.js";

const worker = vi.hoisted(() =>
  vi.fn<(input: unknown) => SkillsDiscoveryOutput | Promise<SkillsDiscoveryOutput>>(),
);
vi.mock("../../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/worker-task-server.js")>()),
  serveWorkerTasks: (handler: (input: unknown) => SkillsDiscoveryOutput) =>
    worker.mockImplementation(handler),
}));
import "./discovery.worker.js";

type ScanRequest = Extract<SkillsDiscoveryInput, { kind: "scan" }>["requests"][number];
const request = (key: string, selection: ScanRequest["selection"]): ScanRequest => ({
  key,
  environment: captureSkillsDiscoveryEnvironment(),
  selection,
});
const write = (dir: string, name: string, description: string) =>
  writeSkill({ dir: path.join(dir, name), name, description });
const localFact = (index: number) => [`local-${index}`, `Workspace ${index}`] as const;
async function scan(requests: ScanRequest[]) {
  const result = await worker({ kind: "scan", path: process.env.PATH, requests });
  if (result.kind !== "scan") {
    throw new Error("Expected scan results");
  }
  return result.results;
}
const facts = ({ skill }: SkillEntry) => [skill.name, skill.description] as const;
function selected(
  workspaceDir: string,
  roots: WorkspaceSkillSource[],
  limits = resolveSkillDiscoveryLimits(),
  key = workspaceDir,
) {
  const sourcePlan = { workspaceDir, roots, managedSkillsDir: roots[0]!.dir, pluginSkillRoots: [] };
  return request(key, { kind: "selected", request: { sourcePlan, limits, additionalBins: [] } });
}
async function workspaces(root: string) {
  const dirs = [path.join(root, "first"), path.join(root, "second")];
  for (const [index, dir] of dirs.entries()) {
    await write(path.join(dir, "skills"), `local-${index}`, `Workspace ${index}`);
  }
  return dirs;
}

const temporary = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    clearCurrentPluginMetadataSnapshot();
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    pinConfigDir();
    cleanup();
  }),
);

it.each(["standalone", "gateway"])(
  "%s discovery shares plugin inventory across workspaces and follows owner publication",
  async (owner) => {
    const root = temporary.make("skills-scan-inventory-");
    const stateDir = path.join(root, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    pinConfigDir();
    const pluginRoot = path.join(root, "plugin");
    const dirs = await workspaces(root);
    const config: OpenClawConfig = {
      plugins: { load: { paths: [pluginRoot] }, entries: { fixture: { enabled: true } } },
    };
    const planning = {
      config,
      bundledSkillsDir: "",
      managedSkillsDir: path.join(stateDir, "skills"),
      pluginSkillsDir: path.join(stateDir, "plugin-skills"),
    };
    writeRegistryPackagePlugin(pluginRoot, { pluginId: "fixture" });
    const publishPlugin = async (name: string) => {
      await write(pluginRoot, name, "Original");
      await fs.writeFile(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({ id: "fixture", configSchema: { type: "object" }, skills: [name] }),
      );
      const index = withPluginCache(createPluginCache(), () =>
        loadInstalledPluginIndex({ config, env: process.env }),
      );
      await writePersistedInstalledPluginIndex(index, { env: process.env });
      if (owner === "gateway") {
        setGatewayPluginMetadataSnapshot(
          createPluginMetadataSnapshotFixture({
            plugins: [{ id: "fixture", origin: "config", rootDir: pluginRoot, skills: [name] }],
          }),
          { config },
        );
      }
    };
    const assertInventory = async (pluginName: string, description: string) => {
      const observed = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const requests = dirs.map((workspaceDir) =>
          request(workspaceDir, {
            kind: "planned",
            plan: { input: captureSkillsSourcePlanInput(workspaceDir, planning) },
            request: { limits: resolveSkillDiscoveryLimits(), additionalBins: [] },
          }),
        );
        const results = await scan(structuredClone(requests));
        const expected = dirs.map((_, index) =>
          [localFact(index), [pluginName, description] as const].toSorted((a, b) =>
            a[0].localeCompare(b[0]),
          ),
        );
        expect(
          results.map(({ key, sources }) =>
            mergeSkillRecords(sources.entries, key)
              .map(facts)
              .toSorted((a, b) => a[0].localeCompare(b[0])),
          ),
        ).toEqual(expected);
        expect(
          observed.queries.filter((sql) =>
            /^select "state_key", "value_json" from "config_machine_state"/i.test(sql),
          ),
        ).toHaveLength(owner === "gateway" ? 0 : 1);
      } finally {
        observed.restore();
      }
    };
    await publishPlugin("original");
    await assertInventory("original", "Original");
    await write(pluginRoot, "original", "Edited");
    await assertInventory("original", "Edited");
    await publishPlugin("successor");
    await assertInventory("successor", "Original");
  },
);

it("reads shared skill roots once per scan while retaining workspace entries and fresh content", async () => {
  const root = temporary.make("skills-scan-shared-roots-");
  const sharedDir = path.join(root, "shared");
  const sharedFile = path.join(sharedDir, "guide", "SKILL.md");
  const dirs = await workspaces(root);
  const requests = dirs.map((workspaceDir, index) =>
    selected(workspaceDir, [
      { dir: sharedDir, source: "openclaw-managed", tier: "managed", order: index + 1 },
      { dir: path.join(workspaceDir, "skills"), source: "openclaw-workspace", tier: "workspace" },
    ]),
  );
  const opened = vi.spyOn(boundaryFileRead, "openRootFileSync");
  for (const description of ["Original", "Edited"]) {
    await write(sharedDir, "guide", description);
    opened.mockClear();
    const results = await scan(requests);
    const expected = dirs.map((_, index) => [
      ["guide", description, index + 1],
      [...localFact(index), undefined],
    ]);
    expect(
      results.map(({ sources }) =>
        sources.entries.map((entry) => [...facts(entry), entry.sourceOrder]),
      ),
    ).toEqual(expected);
    expect(opened.mock.calls.filter(([params]) => params.absolutePath === sharedFile)).toHaveLength(
      1,
    );
  }
});

it("keeps shared-root file limits and hardlink policies separate within a scan", async () => {
  const root = temporary.make("skills-scan-root-policy-");
  const sharedDir = path.join(root, "shared");
  await write(sharedDir, "guide", "Guide");
  await write(sharedDir, "linked", "Linked");
  await fs.link(path.join(sharedDir, "linked", "SKILL.md"), path.join(root, "other-link.md"));
  const policies = [
    [false, 256_000],
    [false, 1],
    [true, 256_000],
  ] as const;
  const results = await scan(
    policies.map(([rejectHardlinks, maxSkillFileBytes], index) =>
      selected(
        root,
        [{ dir: sharedDir, source: "openclaw-managed", tier: "managed", rejectHardlinks }],
        { ...resolveSkillDiscoveryLimits(), maxSkillFileBytes },
        String(index),
      ),
    ),
  );
  expect(results.map(({ sources }) => sources.entries.map(({ skill }) => skill.name))).toEqual([
    ["guide", "linked"],
    [],
    ["guide"],
  ]);
});
