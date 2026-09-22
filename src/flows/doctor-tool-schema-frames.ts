import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { findModelInCatalog, type ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { supportsModelTools } from "../agents/model-tool-support.js";
import { readPreparedModelCatalog } from "../agents/prepared-model-catalog.js";
import { resolveDoctorPrimaryModelRef } from "../commands/doctor/shared/primary-model-ref.js";
import { isUpdateDoctorLintPass } from "../commands/doctor/shared/update-phase.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

export type DoctorToolSchemaFrame = {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  modelRef: { provider: string; model: string };
  model: ProviderRuntimeModel;
  capabilityProfile: ReturnType<typeof resolveConversationCapabilityProfile>;
};

export type DoctorToolSchemaOptions = {
  mode?: HealthCheckContext["mode"];
  env?: NodeJS.ProcessEnv;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  deferInspectionDisposal?: (dispose: () => Promise<void>) => void;
};

function modelContextFinding(agentId: string, reason: string, deferred = false): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "warning",
    message: deferred
      ? `Agent ${agentId} model-specific tool schema inspection was deferred because its provider needs live model discovery.`
      : `Agent ${agentId} runtime tool schema inspection could not prepare its selected model context.`,
    errorCode: deferred ? "provider-dynamic-model-deferred" : "model-context-unavailable",
    path: `agents.${agentId}.model`,
    requirement: reason,
    fixHint: deferred
      ? "Use the model in an authenticated agent run to validate its tool schemas."
      : "Resolve the provider/model loading problem, then rerun doctor to validate model-specific tool schemas.",
  };
}

function buildDoctorRuntimeModel(params: {
  entry?: ModelCatalogEntry;
  provider: string;
  modelId: string;
}): ProviderRuntimeModel {
  const provider = params.provider || DEFAULT_PROVIDER;
  const id = params.modelId || DEFAULT_MODEL;
  const api = params.entry?.api ?? (provider === "openai" ? "openai-responses" : undefined);
  const baseUrl =
    params.entry?.baseUrl ??
    (api === "openai-chatgpt-responses"
      ? "https://chatgpt.com/backend-api"
      : provider === "openai"
        ? "https://api.openai.com/v1"
        : undefined);
  return {
    ...params.entry,
    provider,
    id,
    name: params.entry?.name ?? id,
    ...(api ? { api } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  } as ProviderRuntimeModel; // SAFETY: Inspection omits inference fields; schema-hook failures become findings.
}

/** Prepare each agent's local facts before acquiring the operation's tool registrations. */
export async function prepareDoctorToolSchemaFrames(
  cfg: OpenClawConfig,
  options: DoctorToolSchemaOptions = {},
): Promise<{ frames: DoctorToolSchemaFrame[]; findings: HealthFinding[] }> {
  const env = options.env ?? process.env;
  const standalone =
    options.mode !== undefined && options.mode !== "lint" && !isUpdateDoctorLintPass(env);
  const frames: DoctorToolSchemaFrame[] = [];
  const findings: HealthFinding[] = [];
  for (const agentId of listAgentIds(cfg)) {
    const agent = resolveAgentConfig(cfg, agentId);
    if (agent?.runtime?.type === "acp") {
      continue;
    }
    const agentDir = resolveAgentDir(cfg, agentId, env);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId, env);
    const prepare = async () => {
      const modelRef = standalone
        ? resolveDoctorPrimaryModelRef(cfg, agent?.model)
        : resolveDefaultModelForAgent({ cfg, agentId, allowPluginNormalization: true });
      let model: ProviderRuntimeModel;
      if (standalone) {
        const { resolveModelAsync } = await import("../agents/embedded-agent-runner/model.js");
        const resolution = await resolveModelAsync(
          modelRef.provider,
          modelRef.model,
          agentDir,
          cfg,
          {
            modelIdSource: "selected",
            agentId,
            workspaceDir,
            skipAgentDiscovery: true,
            allowBundledStaticCatalogFallback: true,
            deferProviderDynamicModelPreparation: true,
          },
        );
        if (!resolution.model) {
          findings.push(
            modelContextFinding(agentId, resolution.error, Boolean(resolution.deferred)),
          );
          return;
        }
        model = resolution.model;
      } else {
        // Lint and shipped updater passes retain their saved, read-only catalog contract.
        const catalog = await readPreparedModelCatalog({
          config: cfg,
          agentId,
          agentDir,
          readOnly: true,
          providerDiscoveryProviderIds: [],
        });
        model = buildDoctorRuntimeModel({
          entry: findModelInCatalog(catalog, modelRef.provider, modelRef.model),
          provider: modelRef.provider,
          modelId: modelRef.model,
        });
      }
      if (!supportsModelTools(model)) {
        return;
      }
      const capabilityProfile = resolveConversationCapabilityProfile({
        config: cfg,
        agentId,
        agentDir,
        workspaceDir,
        modelProvider: modelRef.provider,
        modelId: modelRef.model,
        modelApi: model.api,
        modelContextWindowTokens: model.contextWindow,
      });
      frames.push({ agentId, agentDir, workspaceDir, modelRef, model, capabilityProfile });
    };
    try {
      if (options.runWithPluginMetadataSnapshot) {
        await options.runWithPluginMetadataSnapshot({ config: cfg, workspaceDir }, prepare);
      } else {
        await prepare();
      }
    } catch (error) {
      findings.push(modelContextFinding(agentId, formatErrorMessage(error)));
    }
  }
  return { frames, findings };
}
