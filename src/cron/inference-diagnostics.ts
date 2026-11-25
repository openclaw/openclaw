import { resolveSessionAuthProfilePreference } from "../agents/auth-profiles/selection-preference.js";
import { resolveSessionAuthProfileOverrideCompatibility } from "../agents/auth-profiles/session-override.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  selectCliExecutionAuthProfile,
} from "../agents/cli-execution-auth.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveSessionAuthProfileOverrideSource } from "../config/sessions/auth-profile-override-provenance.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
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
export async function prepareCronInferenceDiagnosticSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  signal?: AbortSignal;
  job: Pick<CronStoredJob, "id" | "sessionTarget" | "sessionKey">;
}) {
  const { cfg, agentId, job, signal } = params;
  signal?.throwIfAborted();
  const targetKey = resolveCronSessionTargetSessionKey(job.sessionTarget);
  const sessionKey = resolveCronAgentSessionKey({
    cfg,
    agentId,
    sessionKey: targetKey ?? `cron:${job.id}`,
  });
  if (targetKey) {
    // Session-event admission pins the existing incarnation even after configured expiry.
    const read = await readSessionEntriesFromStoreInWorker({
      agentId,
      sessionKeys: [sessionKey],
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    });
    signal?.throwIfAborted();
    const entry = read.entries[0]?.entry;
    if (entry) {
      return { sessionEntry: entry, initialSessionEntry: entry, isNewSession: false };
    }
    // With no incarnation to pin, retain the existing fresh-session preparation.
  }
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

/** Read-only CLI warnings and prepared host auth facts; never grants account adoption. */
export async function inspectCronInferenceAccount(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  job: Pick<CronStoredJob, "id" | "name">;
  provider: string;
  model: string;
  configuredProfileId?: string;
  signal?: AbortSignal;
  session: Pick<
    Awaited<ReturnType<typeof prepareCronSession>>,
    "sessionEntry" | "initialSessionEntry" | "isNewSession"
  >;
}): Promise<
  | { cliExecution: true; warning?: string }
  | {
      cliExecution: false;
      preference: ReturnType<typeof resolveSessionAuthProfilePreference>;
      store: AuthProfileStore | undefined;
    }
> {
  const { cfg, agentId, provider, model, session, job } = params;
  params.signal?.throwIfAborted();
  // Compatibility is checked on the read-only snapshot, never persisted as a repair.
  const store = session.sessionEntry.authProfileOverride
    ? await loadAuthProfileStoreWithoutExternalProfilesAsync(params.agentDir)
    : undefined;
  params.signal?.throwIfAborted();
  const sessionProfileId =
    store &&
    resolveSessionAuthProfileOverrideCompatibility({
      cfg: resolveModelProviderAuthConfig({ config: cfg, provider, modelId: model }),
      agentDir: params.agentDir,
      entry: session.sessionEntry,
      store,
      provider,
      providers: [provider],
    }) === "incompatible"
      ? undefined
      : session.sessionEntry.authProfileOverride;
  const preference = resolveSessionAuthProfilePreference({
    cfg,
    agentId,
    provider,
    modelId: model,
    configuredProfileId: params.configuredProfileId,
    sessionProfileId,
    sessionProfileSource: resolveSessionAuthProfileOverrideSource(session.sessionEntry),
  });
  const execution = resolveCronCandidateExecution(
    {
      cfg,
      agentId,
      provider,
      model,
      authProfileId: preference?.profileId,
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
    return { cliExecution: false, preference, store };
  }
  if (
    !cliBackendAcceptsAuthProfileForwarding({
      provider: execution.executionProvider,
      config: cfg,
      agentId,
    })
  ) {
    return { cliExecution: true };
  }
  params.signal?.throwIfAborted();
  const authStore =
    store ?? (await loadAuthProfileStoreWithoutExternalProfilesAsync(params.agentDir));
  params.signal?.throwIfAborted();
  const selected = selectCliExecutionAuthProfile({
    cliExecutionProvider: execution.executionProvider,
    authProfileProvider: provider,
    config: cfg,
    store: authStore,
    readinessMode: "read-only",
    selected: preference
      ? { authProfileId: preference.profileId, authProfileIdSource: preference.source }
      : undefined,
    sessionBinding: session.isNewSession
      ? undefined
      : getCliSessionBinding(session.sessionEntry, execution.executionProvider),
  });
  if (selected?.kind !== "stored") {
    return { cliExecution: true };
  }
  const modelRef = `${provider}/${model}`;
  const edit = `openclaw automations edit ${quoteCliArg(job.id)} --model`;
  const native =
    execution.executionProvider === "claude-cli"
      ? ` To explicitly use Claude CLI's native login instead, run ${edit} ${quoteCliArg(`${modelRef}@anthropic:claude-cli`)}.`
      : "";
  return {
    cliExecution: true,
    warning: `Automation ${job.name || job.id} (${job.id}): runtime ${execution.executionProvider} on ${modelRef} selects stored inference account ${selected.profileId}. Scheduled CLI runs never borrow a stored account; an explicit choice is required. To adopt it, run ${edit} ${quoteCliArg(`${modelRef}@${selected.profileId}`)}. This also sets the primary model.${native}`,
  };
}
