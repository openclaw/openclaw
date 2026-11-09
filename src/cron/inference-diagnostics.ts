import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  selectCliExecutionAuthProfile,
} from "../agents/cli-execution-auth.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveSessionAuthProfileOverrideSource } from "../config/sessions/auth-profile-override-provenance.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronCandidateExecution } from "./isolated-agent/candidate-execution.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import { prepareCronSession } from "./isolated-agent/session.js";
import {
  isDetachedCronSessionTarget,
  resolveCronSessionTargetSessionKey,
} from "./session-target.js";
import type { CronStoredJob } from "./types.js";

/** Read the same carried preferences and native resume identity as a scheduled run. */
export function prepareCronInferenceDiagnosticSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  job: Pick<CronStoredJob, "id" | "sessionTarget" | "sessionKey">;
}) {
  const { cfg, agentId, job } = params;
  const sessionKey = resolveCronAgentSessionKey({
    cfg,
    agentId,
    sessionKey: resolveCronSessionTargetSessionKey(job.sessionTarget) ?? `cron:${job.id}`,
  });
  return prepareCronSession({
    cfg,
    agentId,
    sessionKey,
    sourceSessionKey:
      job.sessionTarget === "current" && job.sessionKey
        ? resolveCronAgentSessionKey({ cfg, agentId, sessionKey: job.sessionKey })
        : undefined,
    forceNew: isDetachedCronSessionTarget(job.sessionTarget),
    exactRunSession: true,
    nowMs: Date.now(),
  });
}

/** Undefined means a non-CLI route; CLI inspection never grants account adoption. */
export async function inspectCronCliInferenceAccount(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  job: Pick<CronStoredJob, "id" | "name">;
  provider: string;
  model: string;
  configuredProfileId?: string;
  session: Awaited<ReturnType<typeof prepareCronSession>>;
}): Promise<{ warning?: string } | undefined> {
  const { cfg, agentId, provider, model, session, job } = params;
  const execution = resolveCronCandidateExecution(
    {
      cfg,
      agentId,
      provider,
      model,
      authProfileId: params.configuredProfileId,
      sessionEntry: session.sessionEntry,
      sessionRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
        cfg,
        provider,
        entry: session.sessionEntry,
      }),
    },
    { isCliProvider, resolveEffectiveAgentRuntime },
  );
  if (!execution.cliExecution) {
    return undefined;
  }
  if (
    !cliBackendAcceptsAuthProfileForwarding({
      provider: execution.executionProvider,
      config: cfg,
      agentId,
    })
  ) {
    return {};
  }
  const source = resolveSessionAuthProfileOverrideSource(session.sessionEntry);
  const pinnedSession = source === "user" || source === "user-link";
  const authProfileId =
    (pinnedSession ? session.sessionEntry.authProfileOverride : undefined) ??
    params.configuredProfileId ??
    session.sessionEntry.authProfileOverride;
  const selected = selectCliExecutionAuthProfile({
    cliExecutionProvider: execution.executionProvider,
    authProfileProvider: provider,
    config: cfg,
    store: await loadAuthProfileStoreWithoutExternalProfilesAsync(params.agentDir),
    readinessMode: "read-only",
    selected: authProfileId
      ? {
          authProfileId,
          authProfileIdSource: pinnedSession || params.configuredProfileId ? "user" : "auto",
        }
      : undefined,
    sessionBinding: session.isNewSession
      ? undefined
      : getCliSessionBinding(session.sessionEntry, execution.executionProvider),
  });
  if (selected?.kind !== "stored") {
    return {};
  }
  const modelRef = `${provider}/${model}`;
  const edit = `openclaw automations edit ${quoteCliArg(job.id)} --model`;
  const native =
    execution.executionProvider === "claude-cli"
      ? ` To explicitly use Claude CLI's native login instead, run ${edit} ${quoteCliArg(`${modelRef}@anthropic:claude-cli`)}.`
      : "";
  return {
    warning: `Automation ${job.name || job.id} (${job.id}): runtime ${execution.executionProvider} on ${modelRef} selects stored inference account ${selected.profileId}. Scheduled CLI runs never borrow a stored account; an explicit choice is required. To adopt it, run ${edit} ${quoteCliArg(`${modelRef}@${selected.profileId}`)}. This also sets the primary model.${native}`,
  };
}
