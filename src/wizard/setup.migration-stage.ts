// Setup migration staging keeps provider writes isolated until verified promotion.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { clearRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDurableJsonFile, writeJsonAtomic } from "../infra/json-files.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type {
  MigrationApplyResult,
  MigrationConfigRuntime,
  MigrationItem,
  MigrationPlan,
} from "../plugins/types.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const PROMOTION_JOURNAL_FILE = "onboarding-promotion.json";
const PROMOTION_JOURNAL_VERSION = 1;
const DEFERRED_REASON = "deferred until durable onboarding promotion";

type PromotionStatus =
  | "prepared"
  | "promoting"
  | "committed"
  | "completed"
  | "rolled-back"
  | "indeterminate";
type PromotionComponent = {
  name: "workspace" | "agent" | "state";
  stagedPath: string;
  finalPath: string;
  status: "staged" | "promoted" | "rolled-back";
  targetWasEmptyDirectory?: boolean;
  emptyTargetBackupPath?: string;
  createdParentPaths?: string[];
};
export type SetupMigrationPromotionOutcome =
  | { kind: "verified-inference"; modelRef: string }
  | { kind: "no-imported-inference" };

export type SetupMigrationPromotionContinuation = {
  providerLabel: string;
  source?: string;
  includeSecrets?: boolean;
  providerOptions?: Record<string, unknown>;
  plan: MigrationPlan;
  stagedResult: MigrationApplyResult;
  deferredResult?: MigrationApplyResult;
  outcome: SetupMigrationPromotionOutcome;
  continueOnboarding: boolean;
  workspaceDir: string;
  stagedReportDir: string;
  stagedRoots: string[];
};

type PromotionJournal = {
  version: typeof PROMOTION_JOURNAL_VERSION;
  status: PromotionStatus;
  providerId: string;
  configHashBefore: string;
  configHashTarget: string;
  components: PromotionComponent[];
  continuation?: SetupMigrationPromotionContinuation;
  updatedAt: string;
};

export type SetupMigrationPromotionResume = {
  journalPath: string;
  continuation: SetupMigrationPromotionContinuation;
  copyReportArtifacts: () => Promise<void>;
  saveDeferredResult: (result: MigrationApplyResult) => Promise<void>;
  complete: () => Promise<void>;
  acknowledge: () => Promise<void>;
  cleanup: () => Promise<void>;
};

type SetupMigrationStagePaths = {
  stateDir: string;
  workspaceDir: string;
  agentDir: string;
  reportDir: string;
};

export type SetupMigrationStage = {
  staged: SetupMigrationStagePaths;
  final: SetupMigrationStagePaths;
  configRuntime: MigrationConfigRuntime;
  getFinalConfig: () => OpenClawConfig;
  getStagedConfig: () => OpenClawConfig;
  replaceStagedConfig: (config: OpenClawConfig) => void;
  projectPlanToStage: (plan: MigrationPlan) => MigrationPlan;
  projectResultToFinal: (result: MigrationApplyResult) => MigrationApplyResult;
  promote: (params: {
    expectedConfig: OpenClawConfig;
    continuation: Omit<
      SetupMigrationPromotionContinuation,
      "stagedReportDir" | "stagedRoots" | "workspaceDir"
    >;
    readConfigFile: () => Promise<OpenClawConfig>;
    commitConfigFile: (config: OpenClawConfig) => Promise<OpenClawConfig>;
  }) => Promise<{ config: OpenClawConfig; resume: SetupMigrationPromotionResume }>;
  cleanup: () => Promise<void>;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function hashConfig(config: OpenClawConfig): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(config)))
    .digest("hex");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function findExistingAncestor(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find an existing parent for migration staging at ${candidate}.`);
    }
    current = parent;
  }
  return current;
}

async function makePrivateStageNear(target: string, label: string): Promise<string> {
  const ancestor = await findExistingAncestor(path.dirname(path.resolve(target)));
  const staged = await fs.mkdtemp(path.join(ancestor, `.openclaw-${label}-`));
  await fs.chmod(staged, 0o700);
  return staged;
}

function replacePathPrefix(value: string, from: string, to: string): string {
  if (value === from) {
    return to;
  }
  const prefix = `${from}${path.sep}`;
  return value.startsWith(prefix) ? `${to}${value.slice(from.length)}` : value;
}

function projectPath(value: string, mappings: ReadonlyArray<readonly [string, string]>): string {
  const mapping = mappings
    .filter(([from]) => value === from || value.startsWith(`${from}${path.sep}`))
    .toSorted(([left], [right]) => right.length - left.length)[0];
  return mapping ? replacePathPrefix(value, mapping[0], mapping[1]) : value;
}

function projectValue(value: unknown, mappings: ReadonlyArray<readonly [string, string]>): unknown {
  if (typeof value === "string") {
    return projectPath(value, mappings);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => projectValue(entry, mappings));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, projectValue(entry, mappings)]),
  );
}

function projectPlanTargets(
  plan: MigrationPlan,
  mappings: ReadonlyArray<readonly [string, string]>,
): MigrationPlan {
  return {
    ...plan,
    ...(plan.target ? { target: projectValue(plan.target, mappings) as string } : {}),
    items: plan.items.map((item) => ({
      ...item,
      ...(item.target ? { target: projectValue(item.target, mappings) as string } : {}),
    })),
    ...(plan.metadata
      ? { metadata: projectValue(plan.metadata, mappings) as Record<string, unknown> }
      : {}),
  };
}

function createInMemoryConfigRuntime(params: {
  finalConfig: OpenClawConfig;
  stagedConfig: OpenClawConfig;
  projectToFinal: (config: OpenClawConfig) => OpenClawConfig;
}): {
  runtime: MigrationConfigRuntime;
  getFinalConfig: () => OpenClawConfig;
  getStagedConfig: () => OpenClawConfig;
  replaceConfigs: (next: { finalConfig: OpenClawConfig; stagedConfig: OpenClawConfig }) => void;
} {
  let finalConfig = structuredClone(params.finalConfig);
  let stagedConfig = structuredClone(params.stagedConfig);
  const mutateConfigFile: MigrationConfigRuntime["mutateConfigFile"] = async <T = void>(
    mutation: Parameters<MigrationConfigRuntime["mutateConfigFile"]>[0],
  ) => {
    const stagedDraft = structuredClone(stagedConfig);
    const context = { snapshot: {} as never, previousHash: null };
    const result = await mutation.mutate(stagedDraft, context);
    // Provider mutations may carry state or generate values. Execute them once,
    // then project the staged result into the publishable config.
    stagedConfig = stagedDraft;
    finalConfig = params.projectToFinal(stagedDraft);
    return {
      nextConfig: stagedConfig,
      result: result as T | undefined,
      path: "<onboarding-migration-stage>",
      previousHash: null,
      snapshot: {} as never,
      persistedHash: null,
      afterWrite: mutation.afterWrite,
      followUp: { mode: "none", reason: "staged migration config", requiresRestart: false },
    };
  };
  const runtime: MigrationConfigRuntime = {
    current: () => stagedConfig,
    mutateConfigFile,
  };
  return {
    runtime,
    getFinalConfig: () => structuredClone(finalConfig),
    getStagedConfig: () => structuredClone(stagedConfig),
    replaceConfigs(next) {
      finalConfig = structuredClone(next.finalConfig);
      stagedConfig = structuredClone(next.stagedConfig);
    },
  };
}

function phasePlan(
  plan: MigrationPlan,
  phase: "before-promotion" | "after-promotion",
): MigrationPlan {
  const items = plan.items.map((item) => {
    const itemPhase = item.applyPhase ?? "before-promotion";
    if (itemPhase === phase || item.status !== "planned") {
      return item;
    }
    return { ...item, status: "skipped" as const, reason: DEFERRED_REASON };
  });
  return { ...plan, items, summary: summarizeMigrationItems(items) };
}

export function buildSetupMigrationPhasePlan(
  plan: MigrationPlan,
  phase: "before-promotion" | "after-promotion",
): MigrationPlan {
  return phasePlan(plan, phase);
}

function takeMatchingItem(items: MigrationItem[], item: MigrationItem): MigrationItem | undefined {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) {
    return undefined;
  }
  return items.splice(index, 1)[0];
}

export function mergeSetupMigrationPhaseResults(params: {
  plan: MigrationPlan;
  staged: MigrationApplyResult;
  deferred?: MigrationApplyResult;
}): MigrationApplyResult {
  const stagedItems = [...params.staged.items];
  const deferredItems = [...(params.deferred?.items ?? [])];
  const items = params.plan.items.map((item) => {
    const source = item.applyPhase === "after-promotion" ? deferredItems : stagedItems;
    return takeMatchingItem(source, item) ?? item;
  });
  const plannedItemIds = new Set(params.plan.items.map((item) => item.id));
  items.push(
    ...stagedItems.filter((item) => !plannedItemIds.has(item.id)),
    ...deferredItems.filter((item) => !plannedItemIds.has(item.id)),
  );
  return {
    ...params.staged,
    items,
    summary: summarizeMigrationItems(items),
    warnings: [
      ...new Set([...(params.staged.warnings ?? []), ...(params.deferred?.warnings ?? [])]),
    ],
    nextSteps: [
      ...new Set([...(params.staged.nextSteps ?? []), ...(params.deferred?.nextSteps ?? [])]),
    ],
  };
}

async function readLatestPromotionJournal(params: {
  stateDir: string;
  providerId: string;
}): Promise<{ path: string; journal: PromotionJournal } | undefined> {
  const root = path.join(params.stateDir, "migration", params.providerId);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return undefined;
    }
    throw error;
  }
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .toSorted((left, right) => right.name.localeCompare(left.name))) {
    const journalPath = path.join(root, entry.name, PROMOTION_JOURNAL_FILE);
    const value = await readDurableJsonFile<PromotionJournal>(journalPath);
    if (value?.version === PROMOTION_JOURNAL_VERSION && value.providerId === params.providerId) {
      return { path: journalPath, journal: value };
    }
  }
  return undefined;
}

async function writePromotionJournal(
  journalPath: string,
  journal: PromotionJournal,
): Promise<void> {
  await writeJsonAtomic(
    journalPath,
    { ...journal, updatedAt: new Date().toISOString() },
    { mode: 0o600, dirMode: 0o700, trailingNewline: true },
  );
}

async function copyPromotionReportArtifacts(params: {
  stagedReportDir: string;
  reportDir: string;
}): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(params.stagedReportDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return;
    }
    throw error;
  }
  await fs.mkdir(params.reportDir, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (
      entry.name === "report.json" ||
      entry.name === "summary.md" ||
      entry.name === PROMOTION_JOURNAL_FILE
    ) {
      continue;
    }
    await fs.cp(
      path.join(params.stagedReportDir, entry.name),
      path.join(params.reportDir, entry.name),
      { recursive: true, force: true },
    );
  }
}

async function cleanupPromotionStaging(continuation: SetupMigrationPromotionContinuation) {
  await Promise.all(
    continuation.stagedRoots.map(
      async (root) => await fs.rm(root, { recursive: true, force: true }),
    ),
  );
}

function createPromotionResume(
  journalPath: string,
  journal: PromotionJournal,
): SetupMigrationPromotionResume {
  const continuation = journal.continuation;
  if (!continuation) {
    throw new Error(`Onboarding migration continuation is missing from ${journalPath}.`);
  }
  return {
    journalPath,
    continuation,
    copyReportArtifacts: async () =>
      await copyPromotionReportArtifacts({
        stagedReportDir: continuation.stagedReportDir,
        reportDir: path.dirname(journalPath),
      }),
    async saveDeferredResult(result) {
      continuation.deferredResult = result;
      await writePromotionJournal(journalPath, journal);
    },
    async complete() {
      journal.status = "completed";
      await writePromotionJournal(journalPath, journal);
    },
    async acknowledge() {
      await Promise.all(
        journal.components.map(async (component) => {
          if (component.emptyTargetBackupPath) {
            await fs.rm(component.emptyTargetBackupPath, { recursive: true, force: true });
          }
        }),
      );
      await fs.rm(journalPath, { force: true });
    },
    cleanup: async () => await cleanupPromotionStaging(continuation),
  };
}

async function removeCreatedPromotionParents(components: PromotionComponent[]): Promise<void> {
  const parents = [
    ...new Set(components.flatMap((component) => component.createdParentPaths ?? [])),
  ].toSorted((left, right) => right.length - left.length || right.localeCompare(left));
  for (const parent of parents) {
    try {
      await fs.rmdir(parent);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        continue;
      }
      throw error;
    }
  }
}

async function rollbackComponents(components: PromotionComponent[]): Promise<boolean> {
  try {
    for (const component of components.toReversed()) {
      const stagedExists = await pathExists(component.stagedPath);
      const finalExists = await pathExists(component.finalPath);
      const backupExists = component.emptyTargetBackupPath
        ? await pathExists(component.emptyTargetBackupPath)
        : false;
      if (!stagedExists && !finalExists) {
        return false;
      }
      if (finalExists && !stagedExists) {
        await fs.mkdir(path.dirname(component.stagedPath), { recursive: true, mode: 0o700 });
        await fs.rename(component.finalPath, component.stagedPath);
      } else if (finalExists && stagedExists) {
        if (
          backupExists ||
          !component.targetWasEmptyDirectory ||
          (await fs.readdir(component.finalPath)).length > 0
        ) {
          return false;
        }
      }
      if (backupExists) {
        if (await pathExists(component.finalPath)) {
          return false;
        }
        await fs.rename(component.emptyTargetBackupPath!, component.finalPath);
      } else if (component.targetWasEmptyDirectory) {
        await fs.mkdir(component.finalPath, { recursive: true, mode: 0o700 });
      }
      component.status = "rolled-back";
    }
    await removeCreatedPromotionParents(components);
    return true;
  } catch {
    return false;
  }
}

async function hasPublishedPromotionComponent(components: PromotionComponent[]): Promise<boolean> {
  for (const component of components) {
    if (component.status === "promoted") {
      return true;
    }
    const [stagedExists, finalExists] = await Promise.all([
      pathExists(component.stagedPath),
      pathExists(component.finalPath),
    ]);
    if (!stagedExists && finalExists) {
      return true;
    }
  }
  return false;
}

/** Reconciles interrupted promotion and returns any committed finalization to resume. */
export async function recoverSetupMigrationPromotion(params: {
  stateDir: string;
  providerId: string;
  readConfigFile: () => Promise<OpenClawConfig>;
}): Promise<SetupMigrationPromotionResume | undefined> {
  const found = await readLatestPromotionJournal(params);
  if (!found) {
    return undefined;
  }
  const journal = found.journal;
  if (journal.status === "rolled-back") {
    if (journal.continuation) {
      await cleanupPromotionStaging(journal.continuation);
    }
    return undefined;
  }
  if (journal.status === "indeterminate") {
    throw new Error(
      `An onboarding migration promotion is indeterminate. Review ${found.path} and run openclaw doctor before retrying.`,
    );
  }
  const currentConfigHash = hashConfig(await params.readConfigFile());
  const allFinal = (
    await Promise.all(journal.components.map((component) => pathExists(component.finalPath)))
  ).every(Boolean);
  if (journal.status === "completed") {
    return createPromotionResume(found.path, journal);
  }
  if (journal.status === "committed") {
    if (currentConfigHash === journal.configHashTarget && allFinal) {
      return createPromotionResume(found.path, journal);
    }
    journal.status = "indeterminate";
    await writePromotionJournal(found.path, journal);
    throw new Error(
      `A committed onboarding migration no longer matches its promoted target. Review ${found.path} and run openclaw doctor before retrying.`,
    );
  }
  if (currentConfigHash === journal.configHashTarget && allFinal) {
    journal.status = "committed";
    await writePromotionJournal(found.path, journal);
    return createPromotionResume(found.path, journal);
  }
  if (currentConfigHash === journal.configHashBefore) {
    if (await hasPublishedPromotionComponent(journal.components)) {
      journal.status = "indeterminate";
      await writePromotionJournal(found.path, journal);
      throw new Error(
        `An interrupted onboarding migration published local data before config commit. Review ${found.path} and run openclaw doctor before retrying.`,
      );
    }
    if (await rollbackComponents(journal.components)) {
      journal.status = "rolled-back";
      await writePromotionJournal(found.path, journal);
      if (journal.continuation) {
        await cleanupPromotionStaging(journal.continuation);
      }
      return undefined;
    }
  }
  journal.status = "indeterminate";
  await writePromotionJournal(found.path, journal);
  throw new Error(
    `Could not reconcile an interrupted onboarding migration. Review ${found.path} and run openclaw doctor before retrying.`,
  );
}

async function listMissingPromotionParents(target: string): Promise<string[]> {
  const missing: string[] = [];
  let current = path.dirname(target);
  while (!(await pathExists(current))) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find an existing parent for migration promotion at ${target}.`);
    }
    current = parent;
  }
  return missing;
}

async function reserveEmptyTargetBackupPath(target: string): Promise<string> {
  const reserved = await fs.mkdtemp(path.join(path.dirname(target), ".openclaw-migration-empty-"));
  await fs.rmdir(reserved);
  return reserved;
}

async function recordPromotionTargetState(component: PromotionComponent): Promise<void> {
  component.createdParentPaths = await listMissingPromotionParents(component.finalPath);
  if (!(await pathExists(component.finalPath))) {
    return;
  }
  const stat = await fs.lstat(component.finalPath);
  if (!stat.isDirectory() || (await fs.readdir(component.finalPath)).length > 0) {
    throw new Error(`Migration target changed before promotion: ${component.finalPath}`);
  }
  component.targetWasEmptyDirectory = true;
  component.emptyTargetBackupPath = await reserveEmptyTargetBackupPath(component.finalPath);
}

async function moveRecordedEmptyTarget(component: PromotionComponent): Promise<void> {
  if (!component.targetWasEmptyDirectory) {
    return;
  }
  const entries = await fs.readdir(component.finalPath);
  if (entries.length > 0) {
    throw new Error(`Migration target changed before promotion: ${component.finalPath}`);
  }
  if (component.emptyTargetBackupPath) {
    await fs.rename(component.finalPath, component.emptyTargetBackupPath);
  } else {
    await fs.rmdir(component.finalPath);
  }
}

async function usesCaseInsensitivePaths(directory: string): Promise<boolean> {
  const probe = await fs.mkdtemp(path.join(directory, ".openclaw-case-probe-"));
  try {
    const alias = path.join(path.dirname(probe), path.basename(probe).toUpperCase());
    if (alias === probe) {
      return false;
    }
    await fs.access(alias);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

async function usesNormalizationInsensitivePaths(directory: string): Promise<boolean> {
  const probe = await fs.mkdtemp(path.join(directory, ".openclaw-normalization-é-"));
  try {
    const alias = path.join(path.dirname(probe), path.basename(probe).normalize("NFD"));
    if (alias === probe) {
      return false;
    }
    await fs.access(alias);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

async function canonicalizePromotionPath(
  candidate: string,
): Promise<{ path: string; caseInsensitive: boolean; normalizationInsensitive: boolean }> {
  const suffix: string[] = [];
  let current = path.resolve(candidate);
  while (true) {
    try {
      const ancestor = await fs.realpath(current);
      const probeDirectory = (await fs.stat(ancestor)).isDirectory()
        ? ancestor
        : path.dirname(ancestor);
      return {
        path: path.join(ancestor, ...suffix.toReversed()),
        caseInsensitive: await usesCaseInsensitivePaths(probeDirectory),
        normalizationInsensitive: await usesNormalizationInsensitivePaths(probeDirectory),
      };
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Could not resolve a promotion target for ${candidate}.`);
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return (
    relative.length === 0 ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function assertSupportedStagedStateTree(params: {
  stagedStateDir: string;
  agentId: string;
  providerId: string;
  reportDirName: string;
}): Promise<void> {
  const assertEntries = async (directory: string, allowed: ReadonlySet<string>) => {
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        return;
      }
      throw error;
    }
    const unexpected = entries.filter((entry) => !allowed.has(entry));
    if (unexpected.length > 0) {
      throw new Error(
        `Migration provider wrote unsupported staged state: ${unexpected
          .map((entry) => path.join(directory, entry))
          .join(", ")}.`,
      );
    }
  };
  await assertEntries(params.stagedStateDir, new Set(["agents", "migration", "state"]));
  await assertEntries(path.join(params.stagedStateDir, "agents"), new Set([params.agentId]));
  await assertEntries(
    path.join(params.stagedStateDir, "agents", params.agentId),
    new Set(["agent"]),
  );
  await assertEntries(path.join(params.stagedStateDir, "migration"), new Set([params.providerId]));
  await assertEntries(
    path.join(params.stagedStateDir, "migration", params.providerId),
    new Set([params.reportDirName]),
  );
}

async function assertDisjointPromotionTargets(
  components: ReadonlyArray<Pick<PromotionComponent, "finalPath">>,
): Promise<void> {
  const canonicalPaths = await Promise.all(
    components.map(async (component) => ({
      component,
      path: await canonicalizePromotionPath(component.finalPath),
    })),
  );
  for (const [index, current] of canonicalPaths.entries()) {
    for (const other of canonicalPaths.slice(index + 1)) {
      const caseInsensitive = current.path.caseInsensitive || other.path.caseInsensitive;
      const normalizationInsensitive =
        current.path.normalizationInsensitive || other.path.normalizationInsensitive;
      const normalizePath = (pathname: string) => {
        const normalized = normalizationInsensitive ? pathname.normalize("NFC") : pathname;
        return caseInsensitive ? normalized.toLocaleLowerCase("en-US") : normalized;
      };
      const currentPath = normalizePath(current.path.path);
      const otherPath = normalizePath(other.path.path);
      if (pathsOverlap(currentPath, otherPath) || pathsOverlap(otherPath, currentPath)) {
        throw new Error(
          `Migration promotion targets overlap: ${current.component.finalPath} and ${other.component.finalPath}.`,
        );
      }
    }
  }
}

export async function createSetupMigrationStage(params: {
  providerId: string;
  stateDir: string;
  workspaceDir: string;
  reportDir: string;
  targetConfig: OpenClawConfig;
}): Promise<SetupMigrationStage> {
  const agentId = resolveDefaultAgentId(params.targetConfig);
  const finalEnv = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const finalAgentDir = resolveAgentDir(params.targetConfig, agentId, finalEnv);
  const stagedStateDir = await makePrivateStageNear(params.stateDir, "migration-state");
  const stagedWorkspaceDir = await makePrivateStageNear(params.workspaceDir, "migration-workspace");
  const stagedAgentDir = path.join(stagedStateDir, "agents", agentId, "agent");
  const stagedReportDir = path.join(
    stagedStateDir,
    "migration",
    params.providerId,
    path.basename(params.reportDir),
  );
  const stageEnv = { ...process.env, OPENCLAW_STATE_DIR: stagedStateDir };
  const stagedConfig: OpenClawConfig = {
    ...structuredClone(params.targetConfig),
    agents: {
      ...structuredClone(params.targetConfig.agents),
      defaults: {
        ...structuredClone(params.targetConfig.agents?.defaults),
        workspace: stagedWorkspaceDir,
      },
    },
  };
  const finalPaths: SetupMigrationStagePaths = {
    stateDir: params.stateDir,
    workspaceDir: params.workspaceDir,
    agentDir: finalAgentDir,
    reportDir: params.reportDir,
  };
  const stagedPaths: SetupMigrationStagePaths = {
    stateDir: stagedStateDir,
    workspaceDir: stagedWorkspaceDir,
    agentDir: stagedAgentDir,
    reportDir: stagedReportDir,
  };
  const toStage = [
    [finalPaths.workspaceDir, stagedPaths.workspaceDir],
    [finalPaths.agentDir, stagedPaths.agentDir],
    [finalPaths.stateDir, stagedPaths.stateDir],
    [finalPaths.reportDir, stagedPaths.reportDir],
  ] as const;
  const toFinal = toStage.map(([finalPath, stagedPath]) => [stagedPath, finalPath] as const);
  const projectConfigToFinal = (config: OpenClawConfig) =>
    projectValue(config, toFinal) as OpenClawConfig;
  const configs = createInMemoryConfigRuntime({
    finalConfig: params.targetConfig,
    stagedConfig,
    projectToFinal: projectConfigToFinal,
  });
  openOpenClawAgentDatabase({ agentId, env: stageEnv });
  let databasesDisposed = false;
  let retainForRecovery = false;

  const disposeDatabases = () => {
    if (databasesDisposed) {
      return;
    }
    clearRuntimeAuthProfileStoreSnapshot(stagedAgentDir);
    const stagedAgentDatabasePath = path.join(stagedAgentDir, "openclaw-agent.sqlite");
    const hasAgentDatabase = disposeOpenClawAgentDatabaseByPath(stagedAgentDatabasePath, {
      env: stageEnv,
    });
    if (hasAgentDatabase) {
      registerOpenClawAgentDatabase({
        agentId,
        path: path.join(finalAgentDir, "openclaw-agent.sqlite"),
        env: stageEnv,
      });
    }
    closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(stageEnv));
    databasesDisposed = true;
  };

  return {
    staged: stagedPaths,
    final: finalPaths,
    configRuntime: configs.runtime,
    getFinalConfig: configs.getFinalConfig,
    getStagedConfig: configs.getStagedConfig,
    replaceStagedConfig(config) {
      configs.replaceConfigs({
        stagedConfig: config,
        finalConfig: projectConfigToFinal(config),
      });
    },
    projectPlanToStage: (plan) => projectPlanTargets(plan, toStage),
    projectResultToFinal: (result) => projectValue(result, toFinal) as MigrationApplyResult,
    async promote({ expectedConfig, continuation, readConfigFile, commitConfigFile }) {
      disposeDatabases();
      const configBefore = await readConfigFile();
      if (hashConfig(configBefore) !== hashConfig(expectedConfig)) {
        throw new Error("Migration config changed before promotion. Review it and retry.");
      }
      const configTarget = configs.getFinalConfig();
      const components: PromotionComponent[] = [
        {
          name: "workspace",
          stagedPath: stagedWorkspaceDir,
          finalPath: params.workspaceDir,
          status: "staged",
        },
        {
          name: "agent",
          stagedPath: stagedAgentDir,
          finalPath: finalAgentDir,
          status: "staged",
        },
        {
          name: "state",
          stagedPath: path.join(stagedStateDir, "state"),
          finalPath: path.join(params.stateDir, "state"),
          status: "staged",
        },
      ];
      const existingComponents: PromotionComponent[] = [];
      for (const component of components) {
        if (component.name === "workspace" || (await pathExists(component.stagedPath))) {
          existingComponents.push(component);
        }
      }
      await assertSupportedStagedStateTree({
        stagedStateDir,
        agentId,
        providerId: params.providerId,
        reportDirName: path.basename(params.reportDir),
      });
      await assertDisjointPromotionTargets([
        ...existingComponents,
        { finalPath: params.reportDir },
      ]);
      await fs.mkdir(params.reportDir, { recursive: true, mode: 0o700 });
      // Snapshot every permitted pre-existing empty target before the journal
      // becomes recoverable, including components promoted later in this loop.
      for (const component of existingComponents) {
        await recordPromotionTargetState(component);
      }
      const journalPath = path.join(params.reportDir, PROMOTION_JOURNAL_FILE);
      const journal: PromotionJournal = {
        version: PROMOTION_JOURNAL_VERSION,
        status: "prepared",
        providerId: params.providerId,
        configHashBefore: hashConfig(configBefore),
        configHashTarget: hashConfig(configTarget),
        components: existingComponents,
        continuation: {
          ...continuation,
          workspaceDir: params.workspaceDir,
          stagedReportDir,
          stagedRoots: [stagedStateDir, stagedWorkspaceDir],
        },
        updatedAt: new Date().toISOString(),
      };
      await writePromotionJournal(journalPath, journal);
      journal.status = "promoting";
      await writePromotionJournal(journalPath, journal);
      try {
        for (const component of journal.components) {
          if (component.targetWasEmptyDirectory) {
            // The target state was journaled before promotion began. Persist the
            // current phase before removal so recovery can recreate the directory.
            await writePromotionJournal(journalPath, journal);
            await moveRecordedEmptyTarget(component);
          }
          await fs.mkdir(path.dirname(component.finalPath), { recursive: true, mode: 0o700 });
          await fs.rename(component.stagedPath, component.finalPath);
          component.status = "promoted";
          await writePromotionJournal(journalPath, journal);
        }
        let committed: OpenClawConfig;
        try {
          committed = await commitConfigFile(configTarget);
        } catch (error) {
          const current = await readConfigFile().catch(() => undefined);
          if (current && hashConfig(current) === journal.configHashTarget) {
            committed = current;
          } else if (current && hashConfig(current) === journal.configHashBefore) {
            throw error;
          } else {
            journal.status = "indeterminate";
            retainForRecovery = true;
            await writePromotionJournal(journalPath, journal);
            throw new Error(
              `Migration config commit is indeterminate. Review ${journalPath} and run openclaw doctor before retrying.`,
              { cause: error },
            );
          }
        }
        journal.configHashTarget = hashConfig(committed);
        journal.status = "committed";
        retainForRecovery = true;
        await writePromotionJournal(journalPath, journal);
        return { config: committed, resume: createPromotionResume(journalPath, journal) };
      } catch (error) {
        if (retainForRecovery) {
          throw error;
        }
        if (await rollbackComponents(journal.components)) {
          journal.status = "rolled-back";
          await writePromotionJournal(journalPath, journal);
          throw error;
        }
        journal.status = "indeterminate";
        retainForRecovery = true;
        await writePromotionJournal(journalPath, journal);
        throw new Error(
          `Migration promotion could not be rolled back. Review ${journalPath} and run openclaw doctor before retrying.`,
          { cause: error },
        );
      }
    },
    async cleanup() {
      if (retainForRecovery) {
        return;
      }
      disposeDatabases();
      await Promise.all([
        fs.rm(stagedStateDir, { recursive: true, force: true }),
        fs.rm(stagedWorkspaceDir, { recursive: true, force: true }),
      ]);
    },
  };
}
