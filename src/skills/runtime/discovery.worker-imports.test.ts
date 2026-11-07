import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  captureSkillsDiscoveryEnvironment,
  type SkillsDiscoveryInput,
  type SkillsDiscoveryOutput,
} from "./discovery-worker-contract.js";

const worker = vi.hoisted(() => ({
  read: undefined as ((input: SkillsDiscoveryInput) => SkillsDiscoveryOutput) | undefined,
}));
vi.mock("../../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/worker-task-server.js")>()),
  serveWorkerTasks: (read: (input: SkillsDiscoveryInput) => SkillsDiscoveryOutput) => {
    worker.read = read;
  },
}));
// mock-isolation: File discovery must not load the Gateway's writable database owner.
vi.mock("../../state/openclaw-state-db.js", () => {
  throw new Error("Skill discovery must not load the writable shared-state database owner");
});
// mock-isolation: Prepared roots must not load another plugin metadata inventory.
vi.mock("../../plugins/plugin-metadata-snapshot.js", () => {
  throw new Error("Prepared skill discovery must not load plugin metadata discovery");
});
// mock-isolation: Skill scans do not read or validate interactive preview bundles.
vi.mock("../loading/plugin-skill-bundle.js", () => {
  throw new Error("Skill discovery must not load plugin skill preview readers");
});

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it("scans workspace and prepared plugin skills without loading metadata discovery", async () => {
  const workspaceDir = temporary.make("discovery-worker-imports-");
  const skillRoot = path.join(workspaceDir, "skills");
  const skillDir = path.join(skillRoot, "fixture");
  await writeSkill({ dir: skillDir, name: "fixture", description: "Workspace instructions" });
  vi.stubEnv("PATH", "");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));

  await import("./discovery.worker.js");
  if (!worker.read) {
    throw new Error("Discovery worker did not register its task handler");
  }
  const result = worker.read({
    kind: "scan",
    path: "",
    requests: [
      {
        key: "workspace",
        environment: captureSkillsDiscoveryEnvironment(),
        selection: {
          kind: "selected",
          request: {
            sourcePlan: {
              workspaceDir,
              managedSkillsDir: path.join(workspaceDir, "managed-skills"),
              pluginSkillRoots: [],
              roots: [{ dir: skillRoot, source: "openclaw-workspace", tier: "workspace" }],
            },
            limits: {
              maxCandidatesPerRoot: 10,
              maxSkillsLoadedPerSource: 10,
              maxSkillFileBytes: 1024,
            },
            additionalBins: [],
          },
        },
      },
    ],
  });
  expect(result).toMatchObject({
    kind: "scan",
    results: [
      {
        key: "workspace",
        sources: {
          entries: [
            {
              skill: {
                name: "fixture",
                description: "Workspace instructions",
                filePath: path.join(skillDir, "SKILL.md"),
              },
            },
          ],
          executionEntries: [],
          runtime: { platform: process.platform, bins: [] },
        },
      },
    ],
  });

  const plan = worker.read({
    kind: "plan",
    input: {
      workspaceDir,
      environment: captureSkillsDiscoveryEnvironment(),
      acpRuntimeAvailable: false,
      pluginContributions: [
        { id: "fixture", origin: "config", rootDir: workspaceDir, roots: ["skills"] },
      ],
      options: {
        bundledSkillsDir: "",
        managedSkillsDir: path.join(workspaceDir, "managed-skills"),
        pluginSkillsDir: path.join(workspaceDir, "plugin-skills"),
      },
    },
  });
  expect(plan).toMatchObject({
    kind: "plan",
    plan: {
      pluginSkillRoots: [{ dir: skillRoot, rejectHardlinks: true }],
      roots: expect.arrayContaining([
        expect.objectContaining({ dir: skillRoot, source: "openclaw-extra", tier: "extra" }),
      ]),
    },
  });
});
