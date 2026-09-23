import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tryResolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import { resolveCliBackendConfig } from "../../../agents/cli-backends.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { resolveCliRuntimeExecutionProvider } from "../../../agents/model-runtime-aliases.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../../../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../../../agents/model-selection-shared.js";
import { NATIVE_CRON_CREATOR_CAPABILITIES } from "../../../agents/tools/cron-tool-creator-cap.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";

/** An incomplete default cap is a review hint, never evidence to grant missing tools. */
export function collectCronNativeToolAdvisories(params: {
  cfg: OpenClawConfig;
  jobs: Array<Record<string, unknown>>;
}): string[] {
  const advisories: string[] = [];
  for (const job of params.jobs) {
    const payload = isRecord(job.payload) ? job.payload : undefined;
    if (
      payload?.kind !== "agentTurn" ||
      payload.toolsAllowIsDefault !== true ||
      !Array.isArray(payload.toolsAllow) ||
      payload.toolsAllow.some((name) => NATIVE_CRON_CREATOR_CAPABILITIES.has(name))
    ) {
      continue;
    }
    const agentId = tryResolveCronJobEffectiveAgentId(
      {
        agentId: normalizeOptionalString(job.agentId),
        sessionKey: normalizeOptionalString(job.sessionKey),
      },
      tryResolveAmbientOwnerAgentId(params.cfg),
    );
    if (!agentId) {
      continue;
    }
    const defaults = resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
    const rawModel =
      normalizeOptionalString(payload.model) ??
      resolveSubagentConfiguredModelSelection({ cfg: params.cfg, agentId }) ??
      resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
    const model = rawModel
      ? resolveModelRefFromString({
          cfg: params.cfg,
          agentId,
          raw: rawModel,
          defaultProvider: defaults.provider,
          aliasIndex: buildModelAliasIndex({
            cfg: params.cfg,
            agentId,
            defaultProvider: defaults.provider,
          }),
        })?.ref
      : defaults;
    if (!model) {
      continue;
    }
    const backendId =
      resolveCliRuntimeExecutionProvider({
        cfg: params.cfg,
        agentId,
        provider: model.provider,
        modelId: model.model,
        authProfileId: rawModel ? splitTrailingAuthProfile(rawModel).profile : undefined,
      }) ?? model.provider;
    if (!resolveCliBackendConfig(backendId, params.cfg, { agentId })?.projectNativeToolAuthority) {
      continue;
    }
    const name = normalizeOptionalString(job.name) ?? normalizeOptionalString(job.id);
    advisories.push(
      [
        `Automation "${name}" has an automatically captured tool list with no native file, command, or web tools.`,
        "Before the native-tool capture fix in 2026.9.x, scheduled jobs could omit these tools. A restricted creator session can produce the same list; deliberately restricted jobs can be left as is.",
        `To change the list, run ${formatCliCommand('openclaw cron edit <id> --tools "<complete list>" --json')} from an authorized session that holds the tools. Include every tool the job should retain.`,
        "Doctor --fix does not add missing native tools to this list.",
      ].join("\n"),
    );
  }
  return advisories;
}
