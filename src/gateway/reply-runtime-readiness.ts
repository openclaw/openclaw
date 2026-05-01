import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { ensureRuntimePluginsLoaded } from "../agents/runtime-plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import { prepareProviderRuntimeAuth } from "../plugins/provider-runtime.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import {
  markReplyRuntimePluginRegistryPrepared,
  markReplyRuntimeProviderAuthPrepared,
  markReplyRuntimeProviderPrepared,
} from "./reply-runtime-readiness-monitor.js";

const AWS_SDK_AUTH_SENTINEL = "__aws_sdk_auth__";

type Awaitable<T> = T | Promise<T>;

type ReplyRuntimeReadinessPhaseName =
  | "runtime-plugin-registry"
  | "selected-model-metadata"
  | "selected-provider-runtime"
  | "selected-provider-auth"
  | "tool-contracts";

type StartupTrace = {
  measure?: <T>(name: string, run: () => Awaitable<T>) => Promise<T>;
};

export type ReplyRuntimeReadinessPhaseResult = {
  phase: ReplyRuntimeReadinessPhaseName;
  status: "ready" | "degraded";
  durationMs: number;
  detail?: string;
};

export type ReplyRuntimeReadinessResult = {
  status: "ready" | "degraded";
  provider: string;
  model: string;
  phases: ReplyRuntimeReadinessPhaseResult[];
  reasons: string[];
};

async function measurePhase<T>(
  startupTrace: StartupTrace | undefined,
  traceName: string,
  run: () => Awaitable<T>,
): Promise<T> {
  return startupTrace?.measure ? await startupTrace.measure(traceName, run) : await run();
}

async function resolveSelectedReplyModel(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  provider: string;
  model: string;
}): Promise<{
  runtimeModel: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
}> {
  const { resolveModelAsync } = await import("../agents/pi-embedded-runner/model.js");
  const resolved = await resolveModelAsync(
    params.provider,
    params.model,
    params.agentDir,
    params.cfg,
  );
  if (!resolved.model) {
    throw new Error(resolved.error ?? `Unknown reply model ${params.provider}/${params.model}.`);
  }
  return {
    runtimeModel: resolved.model,
  };
}

export async function prepareReplyRuntimeForChannels(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  startupTrace?: StartupTrace;
}): Promise<ReplyRuntimeReadinessResult> {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, defaultAgentId);
  const agentDir = resolveAgentDir(params.cfg, defaultAgentId);
  const phases: ReplyRuntimeReadinessPhaseResult[] = [];
  const reasons: string[] = [];
  const selected = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let selectedRuntimeModel:
    | import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>
    | undefined;
  const resolveRuntimeModel = async () => {
    if (selectedRuntimeModel) {
      return selectedRuntimeModel;
    }
    const resolved = await resolveSelectedReplyModel({
      cfg: params.cfg,
      agentDir,
      provider: selected.provider,
      model: selected.model,
    });
    selectedRuntimeModel = resolved.runtimeModel;
    return selectedRuntimeModel;
  };

  const runPhase = async (
    phase: ReplyRuntimeReadinessPhaseName,
    detail: string,
    run: () => Promise<void>,
  ): Promise<boolean> => {
    const startedAt = Date.now();
    try {
      await measurePhase(params.startupTrace, `reply-runtime-readiness.${phase}`, run);
      phases.push({
        phase,
        status: "ready",
        durationMs: Date.now() - startedAt,
        detail,
      });
      return true;
    } catch (error) {
      const reason = `${phase}: ${formatErrorMessage(error)}`;
      phases.push({
        phase,
        status: "degraded",
        durationMs: Date.now() - startedAt,
        detail: reason,
      });
      reasons.push(reason);
      return false;
    }
  };

  if (
    !(await runPhase("runtime-plugin-registry", "loaded runtime plugin registry", async () => {
      ensureRuntimePluginsLoaded({
        config: params.cfg,
        workspaceDir,
        source: "gateway.reply-runtime-readiness.runtime-plugin-registry",
      });
      markReplyRuntimePluginRegistryPrepared();
    }))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase(
      "selected-model-metadata",
      `${selected.provider}/${selected.model}`,
      async () => {
        const catalog = await loadModelCatalog({
          config: params.cfg,
          workspaceDir,
          intent: "readiness",
          source: "gateway.reply-runtime-readiness.model-catalog",
          providerDiscoveryProviderIds: [selected.provider],
        });
        if (
          !catalog.some(
            (entry) => entry.provider === selected.provider && entry.id === selected.model,
          )
        ) {
          throw new Error(
            `Selected reply model ${selected.provider}/${selected.model} is not available after readiness model preparation.`,
          );
        }
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase("selected-provider-runtime", selected.provider, async () => {
      const ownerPluginIds =
        resolveOwningPluginIdsForProvider({
          provider: selected.provider,
          config: params.cfg,
          workspaceDir,
          env: process.env,
        }) ?? [];
      if (ownerPluginIds.length === 0) {
        return;
      }
      const plugin = resolveProviderRuntimePlugin({
        provider: selected.provider,
        config: params.cfg,
        workspaceDir,
        env: process.env,
        source: "gateway.reply-runtime-readiness.provider-runtime",
      });
      if (!plugin) {
        throw new Error(`No provider runtime resolved for ${selected.provider}.`);
      }
      markReplyRuntimeProviderPrepared(selected.provider);
    }))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase("selected-provider-auth", selected.provider, async () => {
      const auth = await getApiKeyForModel({
        model: await resolveRuntimeModel(),
        cfg: params.cfg,
        agentDir,
        workspaceDir,
      });
      const apiKey =
        auth.apiKey?.trim() || (auth.mode === "aws-sdk" ? AWS_SDK_AUTH_SENTINEL : undefined);
      if (!apiKey) {
        throw new Error(
          `No credential resolved for ${selected.provider} (auth mode: ${auth.mode}).`,
        );
      }
      const runtimeModel = await resolveRuntimeModel();
      await prepareProviderRuntimeAuth({
        provider: runtimeModel.provider,
        config: params.cfg,
        workspaceDir,
        env: process.env,
        source: "gateway.reply-runtime-readiness.provider-auth",
        context: {
          config: params.cfg,
          agentDir,
          workspaceDir,
          env: process.env,
          provider: runtimeModel.provider,
          modelId: runtimeModel.id,
          model: runtimeModel,
          apiKey,
          authMode: auth.mode,
          profileId: auth.profileId,
        },
      });
      markReplyRuntimeProviderAuthPrepared(selected.provider);
    }))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  if (
    !(await runPhase(
      "tool-contracts",
      "prepared stable core and plugin tool contracts",
      async () => {
        createOpenClawTools({
          config: params.cfg,
          agentDir,
          workspaceDir,
          agentSessionKey: buildAgentMainSessionKey({
            agentId: defaultAgentId,
            mainKey: params.cfg.session?.mainKey,
          }),
        });
      },
    ))
  ) {
    return {
      status: "degraded",
      provider: selected.provider,
      model: selected.model,
      phases,
      reasons,
    };
  }

  return {
    status: "ready",
    provider: selected.provider,
    model: selected.model,
    phases,
    reasons,
  };
}
