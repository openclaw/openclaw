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
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  captureSkillsDiscoveryEnvironment,
  type SkillsDiscoveryInput,
  type SkillsDiscoveryOutput,
} from "./discovery-worker-contract.js";
import { captureSkillsSourcePlanInput } from "./discovery-worker-input.js";

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
      await writeSkill({ dir: path.join(pluginRoot, name), name, description: "Original" });
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
    const scan = async (pluginName: string, description: string) => {
      const observed = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const request: SkillsDiscoveryInput = {
          kind: "scan",
          path: process.env.PATH,
          requests: workspaces.map((workspaceDir) => ({
            key: workspaceDir,
            environment: captureSkillsDiscoveryEnvironment(),
            selection: {
              kind: "planned",
              plan: {
                input: captureSkillsSourcePlanInput(workspaceDir, {
                  config,
                  bundledSkillsDir: "",
                  managedSkillsDir: path.join(stateDir, "skills"),
                  pluginSkillsDir: path.join(stateDir, "plugin-skills"),
                }),
              },
              request: {
                limits: resolveSkillDiscoveryLimits(),
                additionalBins: [],
              },
            },
          })),
        };
        const result = await worker.handle(structuredClone(request));
        if (result.kind !== "scan") {
          throw new Error("Expected scan results");
        }
        expect(
          result.results.map(({ key, sources }) =>
            mergeSkillRecords(sources.entries, key)
              .map(({ skill }) => ({ name: skill.name, description: skill.description }))
              .toSorted((first, second) => first.name.localeCompare(second.name)),
          ),
        ).toEqual(
          workspaces.map((_, index) =>
            [
              { name: `local-${index}`, description: `Workspace ${index}` },
              { name: pluginName, description },
            ].toSorted((first, second) => first.name.localeCompare(second.name)),
          ),
        );
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
    await scan("original", "Original");
    await writeSkill({
      dir: path.join(pluginRoot, "original"),
      name: "original",
      description: "Edited",
    });
    await scan("original", "Edited");
    await publishPlugin("successor");
    await scan("successor", "Original");
  },
);

it("reads shared skill roots once per scan while retaining workspace entries and fresh content", async () => {
  const root = temporary.make("skills-scan-shared-roots-");
  const sharedDir = path.join(root, "shared");
  const sharedFile = path.join(sharedDir, "guide", "SKILL.md");
  const workspaces = [path.join(root, "first"), path.join(root, "second")];
  for (const [index, workspaceDir] of workspaces.entries()) {
    await writeSkill({
      dir: path.join(workspaceDir, "skills", `local-${index}`),
      name: `local-${index}`,
      description: `Workspace ${index}`,
    });
  }
  const request: SkillsDiscoveryInput = {
    kind: "scan",
    path: process.env.PATH,
    requests: workspaces.map((workspaceDir, index) => ({
      key: workspaceDir,
      environment: captureSkillsDiscoveryEnvironment(),
      selection: {
        kind: "selected",
        request: {
          sourcePlan: {
            workspaceDir,
            managedSkillsDir: sharedDir,
            pluginSkillRoots: [],
            roots: [
              {
                dir: sharedDir,
                source: "openclaw-managed",
                tier: "managed",
                order: index + 1,
              },
              {
                dir: path.join(workspaceDir, "skills"),
                source: "openclaw-workspace",
                tier: "workspace",
              },
            ],
          },
          limits: resolveSkillDiscoveryLimits(),
          additionalBins: [],
        },
      },
    })),
  };
  const opened = vi.spyOn(boundaryFileRead, "openRootFileSync");
  for (const description of ["Original", "Edited"]) {
    await writeSkill({ dir: path.dirname(sharedFile), name: "guide", description });
    opened.mockClear();
    const result = await worker.handle(request);
    expect(result.kind).toBe("scan");
    if (result.kind !== "scan") {
      throw new Error("Expected scan results");
    }
    expect(
      result.results.map(({ sources }) =>
        sources.entries.map(({ skill, sourceOrder }) => ({
          name: skill.name,
          description: skill.description,
          sourceOrder,
        })),
      ),
    ).toEqual(
      workspaces.map((_, index) => [
        { name: "guide", description, sourceOrder: index + 1 },
        { name: `local-${index}`, description: `Workspace ${index}`, sourceOrder: undefined },
      ]),
    );
    expect(opened.mock.calls.filter(([params]) => params.absolutePath === sharedFile)).toHaveLength(
      1,
    );
  }
});

it("keeps shared-root file limits and hardlink policies separate within a scan", async () => {
  const root = temporary.make("skills-scan-root-policy-");
  const sharedDir = path.join(root, "shared");
  await writeSkill({ dir: path.join(sharedDir, "guide"), name: "guide", description: "Guide" });
  const linkedDir = path.join(sharedDir, "linked");
  await writeSkill({ dir: linkedDir, name: "linked", description: "Linked" });
  await fs.link(path.join(linkedDir, "SKILL.md"), path.join(root, "other-link.md"));
  const policies = [
    { rejectHardlinks: false, limits: resolveSkillDiscoveryLimits() },
    {
      rejectHardlinks: false,
      limits: { ...resolveSkillDiscoveryLimits(), maxSkillFileBytes: 1 },
    },
    { rejectHardlinks: true, limits: resolveSkillDiscoveryLimits() },
  ];
  const result = await worker.handle({
    kind: "scan",
    path: process.env.PATH,
    requests: policies.map(({ limits, rejectHardlinks }, index) => ({
      key: String(index),
      environment: captureSkillsDiscoveryEnvironment(),
      selection: {
        kind: "selected",
        request: {
          sourcePlan: {
            workspaceDir: root,
            managedSkillsDir: sharedDir,
            pluginSkillRoots: [],
            roots: [
              {
                dir: sharedDir,
                source: "openclaw-managed",
                tier: "managed",
                rejectHardlinks,
              },
            ],
          },
          limits,
          additionalBins: [],
        },
      },
    })),
  } satisfies SkillsDiscoveryInput);
  expect(result.kind).toBe("scan");
  if (result.kind !== "scan") {
    throw new Error("Expected scan results");
  }
  expect(
    result.results.map(({ sources }) => sources.entries.map(({ skill }) => skill.name)),
  ).toEqual([["guide", "linked"], [], ["guide"]]);
});
