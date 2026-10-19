import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type { MigrationPlan } from "../plugins/types.js";
import {
  assertDisjointPromotionTargets,
  type PromotionJournal,
} from "./setup.migration-promotion.js";
import { SetupMigrationTargetChangedError } from "./setup.migration-snapshot.js";
import {
  createSetupMigrationStage,
  recoverSetupMigrationPromotion,
} from "./setup.migration-stage.js";

const tempRoots = createTempDirTracker();
const memoryPath = (root: string) => path.join(root, "MEMORY.md");
const journalPath = (root: string) => path.join(root, "onboarding-promotion.json");
const writeMemory = (root: string, text = "staged\n") => fs.writeFile(memoryPath(root), text);
const readMemory = (root: string) => fs.readFile(memoryPath(root), "utf8");

function migrationPaths(workspaceInState = false) {
  const root = tempRoots.make("openclaw-migration-stage-");
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(workspaceInState ? stateDir : root, "workspace");
  const reportDir = path.join(stateDir, "migration", "claude", "attempt");
  return { root, stateDir, workspaceDir, reportDir };
}

function createStage(paths = migrationPaths()) {
  return createSetupMigrationStage({
    providerId: "claude",
    ...paths,
    targetConfig: { agents: { defaults: { workspace: paths.workspaceDir } } },
  });
}

async function stageMemory(paths = migrationPaths()) {
  const stage = await createStage(paths);
  await writeMemory(stage.staged.workspaceDir);
  return { ...paths, stage };
}

type Stage = Awaited<ReturnType<typeof createStage>>;
type Promotion = Parameters<Stage["promote"]>[0];

function recover(stateDir: string, config: OpenClawConfig = {}) {
  return recoverSetupMigrationPromotion({
    stateDir,
    providerId: "claude",
    readConfigFile: async () => config,
  });
}

async function expectMissing(...paths: string[]) {
  for (const target of paths) {
    await expect(fs.access(target)).rejects.toThrow();
  }
}

function promote(stage: Stage, overrides: Partial<Promotion> = {}) {
  return stage.promote({
    expectedConfig: {},
    continuation: continuation(),
    readConfigFile: async () => ({}),
    commitConfigFile: async (config) => config,
    ...overrides,
  });
}

async function readJournal(reportDir: string): Promise<PromotionJournal> {
  return JSON.parse(await fs.readFile(journalPath(reportDir), "utf8"));
}

function configHash(config: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function continuation(): Promotion["continuation"] {
  const plan = {
    providerId: "claude",
    source: "fixture",
    items: [],
    summary: summarizeMigrationItems([]),
  };
  return {
    providerLabel: "Claude",
    plan,
    stagedResult: plan,
    outcome: { kind: "no-imported-inference" },
    continueOnboarding: true,
  };
}

type RecoveryPhase =
  | "published-before-commit"
  | "before-rename"
  | "config-committed"
  | "target-reset";

async function createRecoveryFixture(phase: RecoveryPhase) {
  const beforeRename = phase === "before-rename";
  const { root, stateDir, workspaceDir: finalWorkspace } = migrationPaths();
  const reportDir = path.join(stateDir, "migration", "claude", "attempt");
  const targetConfig = { gateway: { mode: "local" as const } };
  const stagedRoot = path.join(root, "staged-root");
  const stagedWorkspace = path.join(stagedRoot, "workspace");
  await fs.mkdir(reportDir, { recursive: true });
  if (phase !== "target-reset") {
    await fs.mkdir(finalWorkspace, { recursive: true });
  }
  if (beforeRename) {
    await fs.mkdir(stagedWorkspace, { recursive: true });
    await writeMemory(stagedWorkspace);
  }
  await fs.writeFile(
    journalPath(reportDir),
    JSON.stringify({
      version: 1,
      status: phase === "target-reset" ? "committed" : "promoting",
      providerId: "claude",
      configHashBefore: configHash({}),
      configHashTarget: configHash(targetConfig),
      components: [
        {
          name: "workspace",
          stagedPath: stagedWorkspace,
          finalPath: finalWorkspace,
          status: beforeRename ? "staged" : "promoted",
          ...(beforeRename ? { targetWasEmptyDirectory: true } : {}),
        },
      ],
      continuation: {
        ...continuation(),
        workspaceDir: finalWorkspace,
        stagedReportDir: path.join(stagedRoot, "report"),
        stagedRoots: beforeRename ? [stagedRoot] : [],
      },
      updatedAt: "2026-07-21T00:00:01.000Z",
    }),
    { mode: 0o600 },
  );
  return { stateDir, reportDir, targetConfig, stagedWorkspace, finalWorkspace, stagedRoot };
}

afterEach(async () => {
  const [{ closeOpenClawAgentDatabasesForTest }, { closeOpenClawStateDatabaseForTest }] =
    await Promise.all([
      import("../state/openclaw-agent-db.js"),
      import("../state/openclaw-state-db.js"),
    ]);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempRoots.cleanup();
});

it.each([
  ["case", "CaseProbe", "cASEpROBE", "FutureWorkspace", "futureworkspace"],
  ["normalization", "CaféProbe", "Cafe\u0301Probe", "FuturéWorkspace", "Future\u0301Workspace"],
])(
  "compares missing promotion targets using the destination filesystem's %s rules",
  async (_rule, probe, alias, left, right) => {
    const root = tempRoots.make("openclaw-migration-case-");
    await fs.mkdir(path.join(root, probe));
    const originalEntries = await fs.readdir(root);
    const aliases = await fs.stat(path.join(root, alias)).then(
      () => true,
      (error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return false;
      },
    );
    const validation = assertDisjointPromotionTargets([
      { finalPath: path.join(root, left) },
      { finalPath: path.join(root, right, "agent") },
    ]);

    if (aliases) {
      await expect(validation).rejects.toThrow("Migration promotion targets overlap");
    } else {
      await expect(validation).resolves.toBeUndefined();
    }
    expect(await fs.readdir(root)).toEqual(originalEntries);
  },
);

it.runIf(process.platform !== "win32")(
  "rejects overlap through a dangling parent symlink",
  async () => {
    const root = tempRoots.make("openclaw-migration-dangling-parent-");
    const workspace = path.join(root, "future-workspace");
    const alias = path.join(root, "workspace-alias");
    await fs.symlink(workspace, alias);
    await expect(
      assertDisjointPromotionTargets([
        { finalPath: workspace },
        { finalPath: path.join(alias, "agent") },
      ]),
    ).rejects.toThrow("Migration promotion targets overlap");
    expect(await fs.readdir(root)).toEqual(["workspace-alias"]);
  },
);

it("uses the most-specific path mapping when workspace lives under state", async () => {
  const paths = migrationPaths(true);
  const stage = await createStage(paths);
  const { workspaceDir } = paths;
  const target = memoryPath(workspaceDir);
  const plan = {
    ...continuation().plan,
    target,
    items: [
      {
        id: "workspace:memory",
        kind: "memory",
        action: "copy",
        status: "planned",
        target,
      },
    ],
    summary: { ...continuation().plan.summary, total: 1, planned: 1 },
  } satisfies MigrationPlan;

  const projected = stage.projectPlanToStage(plan);

  expect(projected.target).toBe(memoryPath(stage.staged.workspaceDir));
  expect(projected.items[0]?.target).toBe(memoryPath(stage.staged.workspaceDir));
  await stage.cleanup();
});

it("journals pre-existing empty targets before promotion starts", async () => {
  const paths = migrationPaths();
  const { stateDir, workspaceDir, reportDir } = paths;
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.chmod(workspaceDir, 0o755);
  const { stage } = await stageMemory(paths);

  await expect(
    promote(stage, {
      commitConfigFile: async () => {
        throw new Error("commit failed");
      },
    }),
  ).rejects.toThrow("commit failed");

  const journal = await readJournal(reportDir);
  expect(journal.status).toBe("rolled-back");
  expect((await fs.stat(journalPath(reportDir))).mode & 0o777).toBe(0o600);
  await expectMissing(memoryPath(workspaceDir), path.join(stateDir, "agents"));
  expect(journal.components.find((component) => component.name === "workspace")).toMatchObject({
    targetWasEmptyDirectory: true,
    emptyTargetBackupPath: expect.any(String),
  });
  expect(await fs.readdir(workspaceDir)).toEqual([]);
  expect((await fs.stat(workspaceDir)).mode & 0o777).toBe(0o755);
  await stage.cleanup();
});

it("rejects a dangling promotion target without replacing it", async () => {
  const paths = migrationPaths();
  const { root, workspaceDir, reportDir } = paths;
  const workspaceReferent = path.join(root, "workspace-referent");
  await fs.mkdir(workspaceReferent, { recursive: true });
  await fs.symlink(
    workspaceReferent,
    workspaceDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  await fs.rmdir(workspaceReferent);
  const { stage } = await stageMemory(paths);

  await expect(promote(stage)).rejects.toBeInstanceOf(SetupMigrationTargetChangedError);

  expect((await fs.lstat(workspaceDir)).isSymbolicLink()).toBe(true);
  await expectMissing(workspaceReferent, journalPath(reportDir));
  await stage.cleanup();
});

it("rejects staged state that the promotion owner does not publish", async () => {
  const stage = await createStage();
  await fs.mkdir(path.join(stage.staged.stateDir, "credentials"), { recursive: true });
  await fs.writeFile(
    path.join(stage.staged.stateDir, "credentials", "provider.json"),
    "{}\n",
    "utf8",
  );

  await expect(promote(stage)).rejects.toThrow("unsupported staged state");
  await stage.cleanup();
});

it.each(["state", "report"])("rejects overlap through a %s-directory symlink", async (target) => {
  const paths = migrationPaths();
  const { root, stateDir, workspaceDir, reportDir } = paths;
  await fs.mkdir(stateDir, { recursive: true });
  if (target === "state") {
    const alias = path.join(root, "state-alias");
    await fs.symlink(stateDir, alias);
    paths.workspaceDir = path.join(alias, "agents", "main", "agent", "workspace");
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.symlink(workspaceDir, path.join(stateDir, "migration"));
  }
  const { stage } = await stageMemory(paths);
  await expect(promote(stage)).rejects.toThrow("Migration promotion targets overlap");
  if (target === "state") {
    await expectMissing(journalPath(reportDir));
  } else {
    expect(await fs.readdir(workspaceDir)).toEqual([]);
  }
  await stage.cleanup();
});

it.each<RecoveryPhase>([
  "published-before-commit",
  "before-rename",
  "config-committed",
  "target-reset",
])("recovers a promotion at %s", async (phase) => {
  const { stateDir, reportDir, targetConfig, finalWorkspace, stagedWorkspace, stagedRoot } =
    await createRecoveryFixture(phase);
  if (phase === "published-before-commit") {
    await writeMemory(finalWorkspace, "promoted\n");
    await expect(recover(stateDir)).rejects.toThrow("published local data before config commit");
    expect(await readMemory(finalWorkspace)).toBe("promoted\n");
    await expectMissing(stagedWorkspace);
    expect((await readJournal(reportDir)).status).toBe("indeterminate");
  } else if (phase === "target-reset") {
    await expect(recover(stateDir, targetConfig)).rejects.toThrow(
      "no longer matches its promoted target",
    );
  } else if (phase === "before-rename") {
    await recover(stateDir);
    expect(await fs.readdir(finalWorkspace)).toEqual([]);
    await expectMissing(stagedRoot);
  } else {
    const resume = await recover(stateDir, targetConfig);
    expect(resume?.continuation.outcome).toEqual({ kind: "no-imported-inference" });
    expect((await readJournal(reportDir)).status).toBe("committed");
  }
});

it("reconciles a config writer that commits and then throws", async () => {
  const paths = migrationPaths();
  const { stateDir, workspaceDir, reportDir } = paths;
  await fs.mkdir(path.join(stateDir, "migration"), { recursive: true });
  const { stage } = await stageMemory(paths);
  const targetConfig = { agents: { defaults: { workspace: workspaceDir } } };
  let currentConfig: typeof targetConfig | Record<string, never> = {};

  const promoted = await promote(stage, {
    readConfigFile: async () => structuredClone(currentConfig),
    commitConfigFile: async (config) => {
      currentConfig = structuredClone(config) as typeof targetConfig;
      throw new Error("write result lost");
    },
  });

  expect(promoted.config).toEqual(targetConfig);
  expect(await readMemory(workspaceDir)).toBe("staged\n");
  const journal = await readJournal(reportDir);
  expect(journal.status).toBe("committed");
  await promoted.resume.complete();
  await fs.rm(workspaceDir, { recursive: true, force: true });
  const resumed = await recover(stateDir, { gateway: { mode: "local" } });
  expect(resumed?.continuation.outcome).toEqual({ kind: "no-imported-inference" });
  await resumed?.acknowledge();
  await expect(recover(stateDir, structuredClone(currentConfig))).resolves.toBeUndefined();
  await stage.cleanup();
});
