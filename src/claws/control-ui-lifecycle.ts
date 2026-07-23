// Gateway lifecycle orchestration reuses canonical Claw planners and executors.
import { createHash } from "node:crypto";
import type {
  ClawLifecycleApplyResult,
  ClawLifecyclePlanResult,
} from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { stableStringify } from "../agents/stable-stringify.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayCronServiceContract } from "../gateway/server-cron-contract.js";
import { applyClawAddPlan } from "./add.js";
import { withResolvedClawHubSource, type ClawHubCoordinate } from "./clawhub-source.js";
import type { ClawRemovePlan } from "./lifecycle-remove-contract.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import type { ClawReferencedCleanup } from "./package-remove.js";
import { preflightClawPackage } from "./packages.js";
import { readClawManifestFile } from "./reader.js";
import type { ClawAddPlan, ClawDiagnostic, ClawReadResult } from "./types.js";
import { applyClawUpdatePlan, ClawUpdateMutationError } from "./update-apply.js";
import type { ClawUpdatePlan } from "./update-plan-types.js";
import { buildClawUpdatePlan } from "./update-plan.js";

const PLAN_SCHEMA_VERSION = "openclaw.clawsGatewayPlan.v1" as const;
const APPLY_SCHEMA_VERSION = "openclaw.clawsGatewayApply.v1" as const;

type LifecycleContext = {
  config: OpenClawConfig;
  cron: GatewayCronServiceContract;
};

type LoadedClaw = Extract<ClawReadResult, { ok: true }>;

function addCronJob(context: LifecycleContext, input: Record<string, unknown>) {
  // Claw cron declarations have already passed the canonical manifest planner.
  return context.cron.add(input as Parameters<GatewayCronServiceContract["add"]>[0]);
}

function safeBlocker(diagnostic: Pick<ClawDiagnostic, "code" | "path">) {
  return {
    code: diagnostic.code,
    path: diagnostic.path,
    message: "Resolve this OpenClaw state conflict before continuing.",
  };
}

function safeAction(action: {
  kind: string;
  id: string;
  action: string;
  blocked: boolean;
  reason?: string;
}) {
  return {
    kind: action.kind,
    id: action.id,
    action: action.action,
    blocked: action.blocked,
    ...(action.blocked ? { reason: "Current OpenClaw state blocks this action." } : {}),
  };
}

function safeCapability(change: { kind: string; id: string; action: string; reason: string }) {
  return { kind: change.kind, id: change.id, action: change.action, reason: change.reason };
}

export function sealClawLifecyclePlan(
  plan: Omit<ClawLifecyclePlanResult, "schemaVersion" | "planIntegrity">,
  canonicalPlanIntegrity: string,
): ClawLifecyclePlanResult {
  const planIntegrity = `sha256:${createHash("sha256")
    .update(stableStringify({ canonicalPlanIntegrity, plan }))
    .digest("hex")}`;
  return { schemaVersion: PLAN_SCHEMA_VERSION, planIntegrity, ...plan };
}

function projectAddPlan(plan: ClawAddPlan): ClawLifecyclePlanResult {
  return sealClawLifecyclePlan(
    {
      operation: "add",
      target: {
        agentId: plan.agent.finalId,
        name: plan.claw.name,
        targetVersion: plan.claw.version,
      },
      actions: plan.actions.map(safeAction),
      capabilities: plan.capabilityChanges.map(safeCapability),
      blockers: plan.blockers.map(safeBlocker),
      riskAcknowledgementRequired: false,
    },
    plan.planIntegrity,
  );
}

function projectUpdatePlan(plan: ClawUpdatePlan): ClawLifecyclePlanResult {
  return sealClawLifecyclePlan(
    {
      operation: "update",
      target: {
        agentId: plan.agentId,
        ...(plan.currentClaw?.name ? { name: plan.currentClaw.name } : {}),
        ...(plan.currentClaw?.version ? { currentVersion: plan.currentClaw.version } : {}),
        ...(plan.targetClaw?.version ? { targetVersion: plan.targetClaw.version } : {}),
      },
      actions: plan.actions.map(safeAction),
      capabilities: plan.capabilityChanges.map(safeCapability),
      blockers: plan.blockers.map(safeBlocker),
      riskAcknowledgementRequired: false,
    },
    plan.planIntegrity,
  );
}

function projectRemovePlan(plan: ClawRemovePlan): ClawLifecyclePlanResult {
  return sealClawLifecyclePlan(
    {
      operation: "remove",
      target: plan.agentId ? { agentId: plan.agentId } : {},
      actions: plan.actions.map(safeAction),
      capabilities: [],
      blockers: plan.blockers.map((blocker) => ({
        code: blocker.code,
        path: "$",
        message: "Resolve this OpenClaw state conflict before continuing.",
      })),
      riskAcknowledgementRequired: false,
    },
    plan.planIntegrity,
  );
}

function withTrust(
  plan: ClawLifecyclePlanResult,
  trust: { trustWarning?: string; riskAcknowledgementRequired: boolean },
): ClawLifecyclePlanResult {
  return {
    ...plan,
    ...(trust.trustWarning ? { trustWarning: trust.trustWarning } : {}),
    riskAcknowledgementRequired: trust.riskAcknowledgementRequired,
  };
}

async function addPlanContext(context: LifecycleContext, agentId?: string) {
  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    throw new Error("OpenClaw MCP configuration is unavailable.");
  }
  const existingAgentIds = listAgentIds(context.config);
  const cronJobs = await context.cron.list({ includeDisabled: true });
  return {
    ...(agentId ? { agentId } : {}),
    existingAgentIds,
    existingWorkspacePaths: existingAgentIds.map((id) =>
      resolveAgentWorkspaceDir(context.config, id),
    ),
    existingMcpServers: listedMcpServers.mcpServers,
    existingCronJobIds: cronJobs.map((job) => job.id),
    packagePreflight: preflightClawPackage,
  };
}

async function buildAdd(params: {
  loaded: LoadedClaw;
  agentId?: string;
  context: LifecycleContext;
}) {
  return await buildClawAddPlan({
    manifest: params.loaded.manifest,
    source: params.loaded.source,
    diagnostics: params.loaded.diagnostics,
    context: await addPlanContext(params.context, params.agentId),
  });
}

async function readUpdateSource(params: {
  target: string;
  context: LifecycleContext;
}): Promise<LoadedClaw> {
  const status = await readClawStatus(params.target, {
    config: params.context.config,
    readOnly: true,
  });
  if (status.records.length !== 1) {
    throw new Error("Select exactly one installed Claw agent before updating.");
  }
  const source = status.records[0]!.install.claw;
  const loaded = await readClawManifestFile(
    source.kind === "package" ? source.packageRoot : source.manifestPath,
  );
  if (!loaded.ok) {
    throw new Error("The recorded Claw source is unavailable; select a ClawHub release.");
  }
  return loaded;
}

async function buildUpdate(params: {
  target: string;
  loaded: LoadedClaw;
  context: LifecycleContext;
}) {
  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    throw new Error("OpenClaw MCP configuration is unavailable.");
  }
  const plan = await buildClawUpdatePlan({
    agentId: params.target,
    targetManifest: params.loaded.manifest,
    targetSource: params.loaded.source,
    config: params.context.config,
    sourceMcpServers: listedMcpServers.mcpServers,
    packagePreflight: preflightClawPackage,
    diagnostics: params.loaded.diagnostics,
  });
  return { plan, sourceMcpServers: listedMcpServers.mcpServers };
}

function referencedCleanup(removeUnused?: boolean): ClawReferencedCleanup {
  return removeUnused ? { mode: "remove-if-unused" } : { mode: "retain" };
}

export async function planClawAddFromCatalog(params: {
  source: ClawHubCoordinate;
  agentId?: string;
  context: LifecycleContext;
}): Promise<ClawLifecyclePlanResult> {
  const resolved = await withResolvedClawHubSource({
    coordinate: params.source,
    mode: "preview",
    run: async (loaded) => projectAddPlan(await buildAdd({ ...params, loaded })),
  });
  return withTrust(resolved.value, resolved);
}

export async function applyClawAddFromCatalog(params: {
  source: ClawHubCoordinate;
  agentId?: string;
  planIntegrity: string;
  acknowledgeClawHubRisk?: boolean;
  context: LifecycleContext;
}): Promise<ClawLifecycleApplyResult> {
  const resolved = await withResolvedClawHubSource({
    coordinate: params.source,
    mode: "apply",
    acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
    run: async (loaded) => {
      const plan = await buildAdd({ ...params, loaded });
      if (projectAddPlan(plan).planIntegrity !== params.planIntegrity) {
        throw new Error("The Claw add plan changed; preview it again.");
      }
      const result = await applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        runtime: { log: () => undefined, error: () => undefined, exit: () => undefined },
        cronGateway: {
          add: async (input) => await addCronJob(params.context, input),
          list: async () => await params.context.cron.list({ includeDisabled: true }),
        },
      });
      return {
        schemaVersion: APPLY_SCHEMA_VERSION,
        operation: "add" as const,
        status: result.status === "complete" ? ("complete" as const) : ("partial" as const),
        agentId: result.agent.finalId,
        message:
          result.status === "complete" ? "Claw agent added." : "Claw add needs operator attention.",
      };
    },
  });
  return resolved.value;
}

async function withUpdateSource<T>(params: {
  target: string;
  source?: ClawHubCoordinate;
  mode: "preview" | "apply";
  acknowledgeClawHubRisk?: boolean;
  context: LifecycleContext;
  run: (loaded: LoadedClaw) => Promise<T>;
}): Promise<{ value: T; trustWarning?: string; riskAcknowledgementRequired: boolean }> {
  if (params.source) {
    return await withResolvedClawHubSource({
      coordinate: params.source,
      mode: params.mode,
      acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
      run: params.run,
    });
  }
  return {
    value: await params.run(await readUpdateSource(params)),
    riskAcknowledgementRequired: false,
  };
}

export async function planClawUpdate(params: {
  target: string;
  source?: ClawHubCoordinate;
  context: LifecycleContext;
}): Promise<ClawLifecyclePlanResult> {
  const resolved = await withUpdateSource({
    ...params,
    mode: "preview",
    run: async (loaded) => projectUpdatePlan((await buildUpdate({ ...params, loaded })).plan),
  });
  return withTrust(resolved.value, resolved);
}

export async function applyClawUpdate(params: {
  target: string;
  source?: ClawHubCoordinate;
  planIntegrity: string;
  acknowledgeClawHubRisk?: boolean;
  context: LifecycleContext;
}): Promise<ClawLifecycleApplyResult> {
  const resolved = await withUpdateSource({
    ...params,
    mode: "apply",
    run: async (loaded) => {
      const { plan, sourceMcpServers } = await buildUpdate({ ...params, loaded });
      if (projectUpdatePlan(plan).planIntegrity !== params.planIntegrity) {
        throw new Error("The Claw update plan changed; preview it again.");
      }
      try {
        const result = await applyClawUpdatePlan(
          plan,
          { targetManifest: loaded.manifest, targetSource: loaded.source },
          {
            config: params.context.config,
            sourceMcpServers,
            consentPlanIntegrity: plan.planIntegrity,
            packagePreflight: preflightClawPackage,
            cronGateway: {
              add: async (input) => await addCronJob(params.context, input),
              get: async (id) => await params.context.cron.readJob(id),
              remove: async (id) => await params.context.cron.remove(id),
            },
          },
        );
        return {
          schemaVersion: APPLY_SCHEMA_VERSION,
          operation: "update" as const,
          status: "complete" as const,
          agentId: result.agentId,
          message: "Claw agent updated.",
        };
      } catch (error) {
        if (error instanceof ClawUpdateMutationError && error.code === "update_partial") {
          return {
            schemaVersion: APPLY_SCHEMA_VERSION,
            operation: "update" as const,
            status: "partial" as const,
            agentId: plan.agentId,
            message: "Claw update needs operator attention.",
          };
        }
        throw error;
      }
    },
  });
  return resolved.value;
}

export async function planClawRemove(params: {
  target: string;
  removeUnused?: boolean;
  context: LifecycleContext;
}): Promise<ClawLifecyclePlanResult> {
  const plan = await buildClawRemovePlan(params.target, {
    config: params.context.config,
    referencedCleanup: referencedCleanup(params.removeUnused),
  });
  return projectRemovePlan(plan);
}

export async function applyClawRemove(params: {
  target: string;
  removeUnused?: boolean;
  planIntegrity: string;
  context: LifecycleContext;
}): Promise<ClawLifecycleApplyResult> {
  const cleanup = referencedCleanup(params.removeUnused);
  const plan = await buildClawRemovePlan(params.target, {
    config: params.context.config,
    referencedCleanup: cleanup,
  });
  if (projectRemovePlan(plan).planIntegrity !== params.planIntegrity) {
    throw new Error("The Claw removal plan changed; preview it again.");
  }
  const result = await applyClawRemovePlan(plan, {
    config: params.context.config,
    referencedCleanup: cleanup,
    consentPlanIntegrity: plan.planIntegrity,
    cronGateway: {
      get: async (id) => await params.context.cron.readJob(id),
      remove: async (id) => await params.context.cron.remove(id),
    },
  });
  return {
    schemaVersion: APPLY_SCHEMA_VERSION,
    operation: "remove",
    status: result.status === "complete" ? "complete" : "partial",
    agentId: result.agentId,
    message:
      result.status === "complete"
        ? "Claw agent removed."
        : "Claw removal needs operator attention.",
  };
}
