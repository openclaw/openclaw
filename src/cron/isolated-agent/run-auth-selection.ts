import { hasAnyAuthProfileStoreSource } from "../../agents/auth-profiles/source-check.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../../agents/openai-routing.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronScheduledNativePolicy } from "../scheduled-native-policy.js";
import type { CronJob } from "../types.js";
import { resolveScheduledOpenClawAuthPortabilityError } from "./run-auth-portability.js";
import { hasConfiguredAuthProfiles, loadCronAuthProfileRuntime } from "./run-prepare-runtime.js";
import type { MutableCronSession } from "./run-session-state.js";

type CronAuthProfileSelection = {
  authProfileId?: string;
  authPortabilityError?: string;
};

export async function resolveCronAuthProfileSelection(params: {
  cfg: OpenClawConfig;
  provider: string;
  effectiveAgentRuntime: string;
  agentDir: string;
  agentSessionKey: string;
  sessionTarget: CronJob["sessionTarget"];
  cronSession: MutableCronSession;
  scheduledNativePolicy?: CronScheduledNativePolicy;
}): Promise<CronAuthProfileSelection> {
  const hasSessionAuthProfileOverride = Boolean(
    params.cronSession.sessionEntry.authProfileOverride?.trim(),
  );
  const authProfileRuntime = await loadCronAuthProfileRuntime();
  const authProfileId =
    !hasSessionAuthProfileOverride &&
    !hasConfiguredAuthProfiles(params.cfg) &&
    !hasAnyAuthProfileStoreSource(params.agentDir)
      ? undefined
      : await authProfileRuntime.resolveSessionAuthProfileOverride({
          // Auth profile resolution can mutate session state; pass the same
          // store and key that persistence will later write.
          cfg: params.cfg,
          provider: params.provider,
          acceptedProviderIds: listOpenAIAuthProfileProvidersForAgentRuntime({
            provider: params.provider,
            harnessRuntime: params.effectiveAgentRuntime,
            config: params.cfg,
          }),
          agentDir: params.agentDir,
          sessionEntry: params.cronSession.sessionEntry,
          sessionStore: params.cronSession.store,
          sessionKey: params.agentSessionKey,
          storePath: params.cronSession.storePath,
          isNewSession: params.cronSession.isNewSession && params.sessionTarget !== "isolated",
        });

  if (params.scheduledNativePolicy?.mode !== "disabled" || !authProfileId) {
    return { authProfileId };
  }
  return {
    authProfileId,
    authPortabilityError: resolveScheduledOpenClawAuthPortabilityError({
      provider: params.provider,
      profileId: authProfileId,
      credential: authProfileRuntime.ensureAuthProfileStore(params.agentDir, {
        config: params.cfg,
        readOnly: true,
      }).profiles[authProfileId],
    }),
  };
}
