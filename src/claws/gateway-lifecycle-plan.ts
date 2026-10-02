import { resolveAgentSessionStoreSurvivorTargets } from "../agents/agent-delete-databases.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubFetch } from "../infra/clawhub-client.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-record-reader.js";
import {
  preflightPluginInstall,
  resolveInstalledClawHubPlugin,
} from "../plugins/plugin-install-preflight.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../state/openclaw-agent-db-registry-listing.js";
import { resolveOpenClawStateDirForDatabasePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import {
  bindClawLifecycleTrust,
  projectClawRemovePlan,
  projectClawSkillWarningReviews,
  projectClawUpdatePlan,
} from "./gateway-plan-projection.js";
import { readClawInventory } from "./inventory-read.js";
import { buildClawRemovePlan } from "./lifecycle-state.js";
import type { ClawMonitorCleanupGateway } from "./monitor-cleanup-contract.js";
import { preflightClawPackage } from "./packages.js";
import { projectClawPluginCapabilityReviews } from "./plugin-capability-review.js";
import { readClawRemoveFacts } from "./remove-facts-read.js";
import type { ClawAddPlan, ClawPackagePreflight, ClawReadResult } from "./types.js";
import { buildClawUpdatePlan } from "./update-plan.js";

type VerifiedClawSource = Extract<ClawReadResult, { ok: true }>;

export class ClawGatewayPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawGatewayPlanError";
  }
}

async function readSourceMcpServers(required: boolean) {
  if (!required) {
    return {};
  }
  const listed = await listConfiguredMcpServers();
  if (!listed.ok) {
    throw new ClawGatewayPlanError(
      "mcp_config_unavailable",
      "Claw MCP source config is unavailable.",
    );
  }
  return listed.mcpServers;
}

export async function prepareGatewayClawUpdatePlanning(input: {
  agentId: string;
  source: ClawHubCoordinate;
  config: OpenClawConfig;
  packagePreflight?: ClawPackagePreflight;
  assertCurrent?: () => void;
}) {
  input.assertCurrent?.();
  const context = captureOpenClawStateReadWorkerContext();
  const path = context.admission.databasePath;
  const stateOptions = { path, env: context.environment };
  const inventory = await readClawInventory(stateOptions, { context, current: true });
  context.admission.assertCurrent();
  input.assertCurrent?.();
  const installed = inventory.installs.find((candidate) => candidate.agentId === input.agentId);
  if (!installed) {
    throw new ClawGatewayPlanError("claw_not_found", "Installed Claw agent was not found.");
  }
  if (
    installed.claw.kind !== "package" ||
    installed.claw.integrityKind !== "artifact" ||
    installed.claw.name !== input.source.packageName
  ) {
    throw new ClawGatewayPlanError(
      "claw_update_source_mismatch",
      "This Claw cannot be updated from the selected ClawHub package.",
    );
  }

  clearLoadInstalledPluginIndexInstallRecordsCache();
  const loadInstallRecords = async () =>
    await loadInstalledPluginIndexInstallRecords({
      filePath: path,
      stateDir: resolveOpenClawStateDirForDatabasePath(path),
      env: context.environment,
      artifactPreservingReadOnly: true,
    });
  const packagePreflight: ClawPackagePreflight =
    input.packagePreflight ??
    (async (pkg, workspace) =>
      await preflightClawPackage(pkg, workspace, {
        config: input.config,
        env: context.environment,
        deps: {
          preflightPlugin: async (params) =>
            await preflightPluginInstall({ ...params, loadInstallRecords }),
        },
      }));
  return {
    inventory,
    stateOptions,
    packagePreflight,
    packageDeps: {
      resolvePlugin: async ({ clawhubPackage }: { clawhubPackage: string }) =>
        await resolveInstalledClawHubPlugin({ clawhubPackage, loadInstallRecords }),
    },
    assertCurrent: () => {
      context.admission.assertCurrent();
      input.assertCurrent?.();
    },
  };
}

export async function buildGatewayClawUpdatePlan(input: {
  agentId: string;
  source: VerifiedClawSource;
  config: OpenClawConfig;
  prepared: Awaited<ReturnType<typeof prepareGatewayClawUpdatePlanning>>;
}) {
  const { prepared, source } = input;
  let desiredAgent: AgentConfig | undefined;
  let targetAddPlan: ClawAddPlan | undefined;
  prepared.assertCurrent();
  const sourceMcpServers = await readSourceMcpServers(
    prepared.inventory.mcpServers.some((ref) => ref.agentId === input.agentId) ||
      Object.keys(source.manifest.mcpServers).length > 0,
  );
  prepared.assertCurrent();
  const plan = await buildClawUpdatePlan({
    agentId: input.agentId,
    targetManifest: source.manifest,
    targetClawMarkdownBody: source.clawMarkdownBody,
    targetOpenClawProfile: source.openClawProfile,
    targetSource: source.source,
    diagnostics: source.diagnostics,
    config: input.config,
    sourceMcpServers,
    inventory: prepared.inventory,
    exactAgentId: true,
    stateOptions: {
      ...prepared.stateOptions,
      readOnly: true,
      packageDeps: prepared.packageDeps,
    },
    packagePreflight: prepared.packagePreflight,
    captureGatewayProjection: (agent, addPlan) => {
      desiredAgent = agent;
      targetAddPlan = addPlan;
    },
  });
  prepared.assertCurrent();
  const updatePluginActions = new Set(
    plan.actions
      .filter(
        (action) =>
          action.kind === "package" &&
          action.id.startsWith("plugin:") &&
          (action.action === "add" || action.action === "change") &&
          !action.blocked,
      )
      .map((action) => action.id),
  );
  const pluginReviews = targetAddPlan
    ? projectClawPluginCapabilityReviews({
        ...targetAddPlan,
        actions: targetAddPlan.actions.filter((action) => updatePluginActions.has(action.id)),
      })
    : [];
  const updateSkillActions = new Set(
    plan.actions
      .filter(
        (action) =>
          action.kind === "package" &&
          action.id.startsWith("skill:") &&
          (action.action === "add" || action.action === "change") &&
          !action.blocked,
      )
      .map((action) => action.id),
  );
  const skillReviews = targetAddPlan
    ? projectClawSkillWarningReviews({
        ...targetAddPlan,
        actions: targetAddPlan.actions.filter((action) => updateSkillActions.has(action.id)),
      })
    : [];
  const projection = projectClawUpdatePlan(plan, source.source.packageRoot, {
    config: input.config,
    desiredAgent,
    currentJobs: prepared.inventory.cronJobs
      .filter((ref) => ref.agentId === input.agentId)
      .map((ref) => ref.job),
    targetJobs: source.manifest.cronJobs ?? [],
    pluginReviews,
    skillReviews,
  });
  return {
    plan,
    projection,
    sourceMcpServers,
    stateOptions: prepared.stateOptions,
    packagePreflight: prepared.packagePreflight,
    packageDeps: prepared.packageDeps,
  };
}

export async function planClawUpdateForGateway(input: {
  agentId: string;
  source: ClawHubCoordinate;
  config: OpenClawConfig;
  baseUrl?: string;
  fetchImpl?: ClawHubFetch;
  packagePreflight?: ClawPackagePreflight;
}) {
  const prepared = await prepareGatewayClawUpdatePlanning(input);
  const resolved = await withResolvedClawHubSource({
    coordinate: input.source,
    mode: "preview",
    baseUrl: input.baseUrl,
    fetchImpl: input.fetchImpl,
    run: async (source) => {
      return (
        await buildGatewayClawUpdatePlan({
          agentId: input.agentId,
          source,
          config: input.config,
          prepared,
        })
      ).projection;
    },
  });
  prepared.assertCurrent();
  return bindClawLifecycleTrust(resolved.value, resolved);
}

export async function planClawRemoveForGateway(input: {
  agentId: string;
  config: OpenClawConfig;
  monitorGateway?: ClawMonitorCleanupGateway;
}) {
  const context = captureOpenClawStateReadWorkerContext();
  const path = context.admission.databasePath;
  const stateOptions = { path, env: context.environment };
  const inventory = await readClawInventory(stateOptions, { context, current: true });
  context.admission.assertCurrent();
  const installed = inventory.installs.find((candidate) => candidate.agentId === input.agentId);
  const exactAgentExists =
    Boolean(installed) ||
    inventory.packages.some((ref) => ref.agentId === input.agentId) ||
    inventory.workspaceFiles.some((ref) => ref.agentId === input.agentId) ||
    inventory.mcpServers.some((ref) => ref.agentId === input.agentId) ||
    inventory.cronJobs.some((ref) => ref.agentId === input.agentId);
  if (!exactAgentExists) {
    const plan = await buildClawRemovePlan(
      input.agentId,
      { ...stateOptions, config: input.config, readOnly: true, exactAgentId: true },
      {
        inventory,
        registeredAgentDatabases: [],
        inspectSessionStoreOwner: () => ({ status: "unreadable" }),
        readAttachedCronJobs: async () => [],
      },
    );
    context.admission.assertCurrent();
    return projectClawRemovePlan(plan);
  }

  const registry = await prepareOpenClawAgentDatabaseRegistrySnapshotRead(stateOptions).read();
  context.admission.assertCurrent();
  registry.assertCurrent();
  if (registry.result.status !== "available") {
    throw new ClawGatewayPlanError(
      "agent_database_registry_unavailable",
      "Agent database ownership cannot be verified for Claw removal.",
    );
  }
  const registeredAgentDatabases = registry.result.entries;
  const sessionStorePaths = [
    ...new Set(
      resolveAgentSessionStoreSurvivorTargets(
        input.config,
        input.agentId,
        registeredAgentDatabases,
        context.environment,
      ).map((target) => target.path),
    ),
  ];
  const initialFacts = await readClawRemoveFacts(
    input.agentId,
    sessionStorePaths.slice(0, 64),
    stateOptions,
    { context, current: true },
  );
  context.admission.assertCurrent();
  registry.assertCurrent();
  const sessionStoreOwners = new Map(
    initialFacts.sessionStoreOwners.map((entry) => [entry.path, entry.owner] as const),
  );
  for (let index = 64; index < sessionStorePaths.length; index += 64) {
    const remaining = await readClawRemoveFacts(
      input.agentId,
      sessionStorePaths.slice(index, index + 64),
      stateOptions,
      { context, current: true },
    );
    context.admission.assertCurrent();
    registry.assertCurrent();
    for (const entry of remaining.sessionStoreOwners) {
      sessionStoreOwners.set(entry.path, entry.owner);
    }
  }
  let firstAttachedJobs: typeof initialFacts.attachedJobs | undefined = initialFacts.attachedJobs;
  const readAttachedCronJobs = async () => {
    if (firstAttachedJobs) {
      const jobs = firstAttachedJobs;
      firstAttachedJobs = undefined;
      return jobs;
    }
    const fresh = await readClawRemoveFacts(input.agentId, [], stateOptions, {
      context,
      current: true,
    });
    context.admission.assertCurrent();
    registry.assertCurrent();
    return fresh.attachedJobs;
  };
  const sourceMcpServers = await readSourceMcpServers(
    inventory.mcpServers.some((ref) => ref.agentId === input.agentId),
  );
  context.admission.assertCurrent();
  registry.assertCurrent();
  clearLoadInstalledPluginIndexInstallRecordsCache();
  const plan = await buildClawRemovePlan(
    input.agentId,
    {
      ...stateOptions,
      readOnly: true,
      config: input.config,
      exactAgentId: true,
      sourceMcpServers,
      monitorGateway: input.monitorGateway,
      packageDeps: {
        resolvePlugin: async ({ clawhubPackage }) =>
          await resolveInstalledClawHubPlugin({
            clawhubPackage,
            loadInstallRecords: async () =>
              await loadInstalledPluginIndexInstallRecords({
                filePath: path,
                stateDir: resolveOpenClawStateDirForDatabasePath(path),
                env: context.environment,
                artifactPreservingReadOnly: true,
              }),
          }),
      },
    },
    {
      inventory,
      registeredAgentDatabases,
      inspectSessionStoreOwner: (pathname) =>
        sessionStoreOwners.get(pathname) ?? { status: "unreadable" },
      readAttachedCronJobs,
    },
  );
  context.admission.assertCurrent();
  registry.assertCurrent();
  return projectClawRemovePlan(
    plan,
    installed ? { name: installed.claw.name, version: installed.claw.version } : undefined,
  );
}
