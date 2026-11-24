import { lstat } from "node:fs/promises";
import path from "node:path";
import type { TemplateLifecyclePlanResult } from "../../packages/gateway-protocol/src/schema/templates.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope-config.js";
import { resolveCanonicalWorkspacePath } from "../agents/workspace-state-identity.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { selectNextTemplateAgentId } from "./add-agent-id.js";
import { readRetainedTemplateInitialization } from "./add-checkpoint.js";
import { readClawHubCatalogExcerpt } from "./clawhub-preview-content.js";
import type { ClawHubTemplateTrust } from "./clawhub-source.js";
import {
  withResolvedTemplateAddSource,
  type TemplateAddSource,
  type TemplateAddStageHook,
} from "./gateway-add-source.js";
import { bindTemplateLifecycleTrust, projectTemplateAddPlan } from "./gateway-plan-projection.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { preflightTemplatePackage } from "./packages.js";
import { projectTemplatePluginCapabilityReviews } from "./plugin-capability-review.js";
import type {
  TemplateAddPlan,
  TemplateAddPlanContext,
  TemplatePackagePreflight,
  TemplateReadResult,
} from "./types.js";

type VerifiedTemplateSource = Extract<TemplateReadResult, { ok: true }>;

function workspacesOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

async function selectNewWorkspace(
  base: string,
  claimedWorkspaces: readonly string[],
): Promise<string> {
  const canonicalParent = resolveCanonicalWorkspacePath(path.dirname(base));
  if (claimedWorkspaces.some((workspace) => isPathInside(workspace, canonicalParent))) {
    return base;
  }
  for (let index = 1; Number.isSafeInteger(index); index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`;
    const canonicalCandidate = resolveCanonicalWorkspacePath(candidate);
    if (claimedWorkspaces.some((workspace) => workspacesOverlap(workspace, canonicalCandidate))) {
      continue;
    }
    try {
      await lstat(candidate);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return candidate;
      }
      throw error;
    }
  }
  throw new Error("No available Template workspace suffix");
}

export async function selectTemplateAgentWorkspace(
  config: OpenClawConfig,
  agentId: string,
): Promise<string> {
  const existingAgentIds = listAgentIds(config);
  const configuredWorkspace = resolveAgentWorkspaceDir(config, agentId);
  const existingWorkspaces = existingAgentIds.map((existingAgentId) => ({
    agentId: normalizeAgentId(existingAgentId),
    workspace: resolveAgentWorkspaceDir(config, existingAgentId),
  }));
  const claimedWorkspaces = existingWorkspaces
    .filter((existing) => existing.agentId !== agentId)
    .map((existing) => resolveCanonicalWorkspacePath(existing.workspace));
  const overlapsConfiguredWorkspace = claimedWorkspaces.some((workspace) =>
    workspacesOverlap(workspace, resolveCanonicalWorkspacePath(configuredWorkspace)),
  );
  const baseWorkspace =
    !resolveAgentConfig(config, agentId)?.workspace && overlapsConfiguredWorkspace
      ? path.join(resolveStateDir(), `workspace-${agentId}`)
      : configuredWorkspace;
  return existingWorkspaces.some((existing) => existing.agentId === agentId)
    ? baseWorkspace
    : await selectNewWorkspace(baseWorkspace, claimedWorkspaces);
}

export type GatewayTemplateAddPlanningContext = {
  config: OpenClawConfig;
  deviceTimeZone?: string;
  sourceMcpServers:
    | Record<string, Record<string, unknown>>
    | (() => Promise<Record<string, Record<string, unknown>>>);
  agentId?: string;
  /** Trusted in-flight creation receipt; never a wire field. */
  admittedWorkspace?: string;
  packagePreflight?: TemplatePackagePreflight;
  resolvePreferredModel?: TemplateAddPlanContext["resolvePreferredModel"];
};

export async function buildGatewayTemplateAddPlan(
  source: VerifiedTemplateSource,
  context: GatewayTemplateAddPlanningContext,
): Promise<TemplateAddPlan> {
  const existingAgentIds = listAgentIds(context.config);
  const agentId = context.agentId
    ? normalizeAgentId(context.agentId)
    : selectNextTemplateAgentId(source.manifest.agent.id, existingAgentIds);
  const workspace =
    context.admittedWorkspace ?? (await selectTemplateAgentWorkspace(context.config, agentId));
  const existingWorkspaces = existingAgentIds.map((id) =>
    resolveAgentWorkspaceDir(context.config, id),
  );
  return await buildTemplateAddPlan({
    manifest: source.manifest,
    templateMarkdownBody: source.templateMarkdownBody,
    packageBootstrap: source.packageBootstrap,
    bundledSources: source.snapshot.bundledSources,
    source: source.source,
    diagnostics: source.diagnostics,
    context: {
      config: context.config,
      deviceTimeZone: context.deviceTimeZone,
      ...(context.agentId ? { agentId: context.agentId } : {}),
      ...(!context.agentId ? { agentId } : {}),
      workspace,
      existingAgentIds,
      existingWorkspacePaths: existingWorkspaces,
      ...(context.admittedWorkspace ? { admittedWorkspace: context.admittedWorkspace } : {}),
      ...(context.resolvePreferredModel
        ? { resolvePreferredModel: context.resolvePreferredModel }
        : {}),
      // Most Templates have no MCP declarations. Do not read and validate the
      // entire authored host configuration for an unrelated requirement type.
      existingMcpServers:
        Object.keys(source.manifest.mcpServers).length === 0
          ? {}
          : typeof context.sourceMcpServers === "function"
            ? await context.sourceMcpServers()
            : context.sourceMcpServers,
      packagePreflight:
        context.packagePreflight ??
        ((pkg, destinationWorkspace, sourceContext) =>
          preflightTemplatePackage(pkg, destinationWorkspace, {
            config: context.config,
            ...sourceContext,
          })),
    },
  });
}

export function projectGatewayTemplateAddPlan(
  plan: TemplateAddPlan,
  source: VerifiedTemplateSource,
  trust: Pick<ClawHubTemplateTrust, "trustWarning" | "riskAcknowledgementRequired">,
  config: OpenClawConfig,
): TemplateLifecyclePlanResult {
  const pluginReviews = projectTemplatePluginCapabilityReviews(plan);
  return bindTemplateLifecycleTrust(
    projectTemplateAddPlan(plan, source.source.packageRoot, pluginReviews, config, source),
    trust,
  );
}

export async function planTemplateAddForGateway(
  input: GatewayTemplateAddPlanningContext &
    ClawHubFetchOptions & {
      source: TemplateAddSource;
      onStage?: TemplateAddStageHook;
    },
): Promise<TemplateLifecyclePlanResult> {
  // Apply resumes an agent that a failed Add kept when its pending initialization
  // matches this source. Review that agent as apply will: without its admission.
  let context: GatewayTemplateAddPlanningContext = input;
  const agentId = input.agentId ? normalizeAgentId(input.agentId) : undefined;
  if (!("kind" in input.source) && agentId && input.config.agents?.entries?.[agentId]) {
    const workspace = await selectTemplateAgentWorkspace(input.config, agentId);
    const retained = await readRetainedTemplateInitialization(
      input.config,
      agentId,
      workspace,
      input.source,
      () => {},
    ).catch(() => undefined);
    if (retained) {
      const entries = { ...input.config.agents.entries };
      delete entries[agentId];
      context = {
        ...input,
        config: { ...input.config, agents: { ...input.config.agents, entries } },
        admittedWorkspace: workspace,
        deviceTimeZone: retained.continuation.deviceTimeZone,
      };
    }
  }
  const resolved = await withResolvedTemplateAddSource({
    coordinate: input.source,
    onStage: input.onStage,
    mode: "preview",
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.token ? { token: input.token } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    run: async (source, trust) => {
      input.onStage?.("plan");
      const plan = await buildGatewayTemplateAddPlan(source, context);
      const projected = projectGatewayTemplateAddPlan(plan, source, trust, context.config);
      if ("kind" in input.source) {
        const instructions = [
          ...Object.entries(source.manifest.workspace.bootstrapFiles).flatMap(([name, file]) =>
            file ? [{ name, source: file.source }] : [],
          ),
          ...source.manifest.workspace.files.map((file) => ({
            name: file.path,
            source: file.source,
          })),
          ...(source.templateMarkdownBody &&
          !source.manifest.workspace.bootstrapFiles["SOUL.md"] &&
          !source.manifest.workspace.files.some((file) => file.path === "SOUL.md")
            ? [{ name: "SOUL.md", source: "CLAW.md#body" }]
            : []),
          ...(source.packageBootstrap
            ? [{ name: "BOOTSTRAP.md", source: source.packageBootstrap.sourcePath }]
            : []),
        ];
        const bundledSkills =
          source.snapshot.bundledSources
            ?.filter((item) => item.kind === "skill")
            .map((item) => ({ name: item.path, source: "bundled" as const, path: item.path })) ??
          [];
        const previewInput = {
          params: { packageName: source.source.name, version: source.source.version },
          instructions,
          skills: bundledSkills,
          verified: source,
          rootDir: source.source.packageRoot,
        };
        const files: NonNullable<TemplateLifecyclePlanResult["reviewFiles"]> = [];
        for (const instruction of instructions) {
          const existing = files.find((file) => file.path === instruction.source);
          if (existing) {
            existing.workspacePaths!.push(instruction.name);
            continue;
          }
          const preview = await readClawHubCatalogExcerpt({
            ...previewInput,
            requested: { kind: "instruction", name: instruction.name },
          });
          files.push({
            path: instruction.source,
            ...(preview ? { content: preview.content } : {}),
            workspacePaths: [instruction.name],
          });
        }
        for (const skill of bundledSkills) {
          const preview = await readClawHubCatalogExcerpt({
            ...previewInput,
            requested: { kind: "skill", name: skill.name },
          });
          files.push({
            path: skill.path + "/SKILL.md",
            ...(preview ? { content: preview.content } : {}),
          });
        }
        projected.reviewFiles = files;
      }
      return projected;
    },
  });
  return resolved.value;
}
