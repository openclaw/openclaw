import {
  resolveSubagentModelConfigSelectionResult,
  tryResolveAmbientOwnerAgentId,
} from "../agents/agent-scope.js";
import { hasSyntheticLocalProviderAuthConfig } from "../agents/model-auth-provider-config.js";
import {
  isCliRuntimeProvider,
  resolveCliRuntimeExecutionProvider,
} from "../agents/model-runtime-aliases.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { normalizeModelSelection } from "../agents/model-selection-shared.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-selection.js";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import type { CronStoredJob } from "../cron/types.js";

/** Startup diagnostics use configured facts only; Doctor remains the sole migration writer. */
export function describeCronInferenceMigration(
  cfg: OpenClawConfig,
  job: CronStoredJob,
): string | undefined {
  if (
    job.payload.kind !== "agentTurn" ||
    job.sessionTarget === "main" ||
    job.inferenceBinding ||
    job.runtimeAuthority ||
    job.runtimeAuthorityRecoveryRequired
  ) {
    return undefined;
  }
  try {
    const agentId = tryResolveCronJobEffectiveAgentId(job, tryResolveAmbientOwnerAgentId(cfg));
    if (!agentId) {
      return undefined;
    }
    const subagent = resolveSubagentModelConfigSelectionResult({ cfg, agentId });
    const selection = resolveSimpleCompletionSelectionForAgent({
      cfg,
      agentId,
      modelRef:
        job.payload.model ??
        (job.payload.externalContentSource === "gmail" ? cfg.hooks?.gmail?.model : undefined) ??
        normalizeModelSelection(subagent?.raw),
    });
    if (!selection) {
      return undefined;
    }
    const runtime = resolveModelRuntimePolicy({
      config: cfg,
      agentId,
      provider: selection.provider,
      modelId: selection.modelId,
    }).policy?.id;
    if (
      (runtime && runtime !== "openclaw" && runtime !== "auto") ||
      isCliRuntimeProvider(selection.provider, { config: cfg }) ||
      resolveCliRuntimeExecutionProvider({
        cfg,
        agentId,
        provider: selection.provider,
        modelId: selection.modelId,
      }) ||
      hasSyntheticLocalProviderAuthConfig({
        cfg,
        provider: selection.provider,
        route: resolveMergedModelProviderConfig(cfg, selection.provider),
      })
    ) {
      return undefined;
    }
    return "cron: automation has no recorded inference account; run openclaw doctor --fix before its next scheduled run to migrate a clear stored account or see the explicit adoption needed. This is an account check, not a requirement to pin its model.";
  } catch {
    // A diagnostic cannot turn an unresolved model/agent into a Gateway startup refusal.
    return "cron: legacy inference account readiness could not be determined; run openclaw doctor --fix before the next scheduled run.";
  }
}
