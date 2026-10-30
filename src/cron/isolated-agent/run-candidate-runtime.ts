import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfile,
} from "../../agents/cli-execution-auth.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveRunAuthProfile } from "../../auto-reply/reply/agent-runner-auth-profile.js";
import { readConfiguredModelAuthProfileProvider } from "../../config/sessions/auth-profile-override-provenance.js";
import { bindRuntimeAuthProfileExecution } from "../../config/sessions/session-entry-current-runtime.js";
import { resolveCronRuntimeSessionEntry } from "../inference-binding.js";
import { resolveCronCandidateExecution } from "./candidate-execution.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Resolves a candidate's runtime override from the job's captured runtime or its cron session. */
export function createCronRuntimeOverrideResolver(
  params: Pick<CronRunExecutionParams, "cfgWithAgentDefaults" | "cronSession" | "job">,
) {
  return (provider: string) =>
    resolveSessionRuntimeOverrideForProvider({
      provider,
      entry: resolveCronRuntimeSessionEntry(
        params.job.inferenceBinding,
        params.cronSession.sessionEntry,
      ),
      cfg: params.cfgWithAgentDefaults,
    });
}

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "runSessionKey" | "cronSession" | "job"
  >,
) {
  return (provider: string, model: string, sessionRuntimeOverride: string | undefined) =>
    resolveCronCandidateExecution(
      {
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        provider,
        model,
        sessionRuntimeOverride,
        sessionKey: params.runSessionKey,
        // A captured runtime stands in for the override copied into the cron session entry.
        sessionEntry: resolveCronRuntimeSessionEntry(
          params.job.inferenceBinding,
          params.cronSession.sessionEntry,
        ),
      },
      { isCliProvider, resolveEffectiveAgentRuntime },
    );
}

/** Prepare provider facts once, then retain a later explicit account intent at use time. */
export function prepareCronCandidateAuthSelection(
  params: Pick<
    CronRunExecutionParams,
    "liveSelection" | "cronSession" | "cfgWithAgentDefaults" | "workspaceDir"
  >,
  provider: string,
) {
  const configuredAuthProvider = readConfiguredModelAuthProfileProvider(
    params.liveSelection,
    params.cronSession.sessionEntry,
  );
  const selectedAuthProfile = configuredAuthProvider
    ? resolveRunAuthProfile(
        {
          provider: configuredAuthProvider,
          authProfileId: params.liveSelection.authProfileId,
          authProfileIdSource: params.liveSelection.authProfileIdSource,
          config: params.cfgWithAgentDefaults,
          workspaceDir: params.workspaceDir,
        },
        provider,
      )
    : params.liveSelection;
  return () => {
    const selection = readConfiguredModelAuthProfileProvider(
      params.liveSelection,
      params.cronSession.sessionEntry,
    )
      ? selectedAuthProfile
      : params.liveSelection;
    return {
      embedded: {
        authProfileId: selection.authProfileId,
        authProfileIdSource: selection.authProfileId ? selection.authProfileIdSource : undefined,
      },
      cli: selection.authProfileId
        ? {
            authProfileId: selection.authProfileId,
            authProfileIdSource:
              selection.authProfileIdSource === "user" ? ("user" as const) : ("auto" as const),
          }
        : undefined,
    };
  };
}

/** Resolve the actual CLI account using the candidate backend forwarding contract. */
export async function resolveCronCliAuthProfile(input: {
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "agentDir" | "cronSession"
  >;
  executionProvider: string;
  provider: string;
  binding: Parameters<typeof resolveCliExecutionAuthProfile>[0]["sessionBinding"];
  selected: Parameters<typeof resolveCliExecutionAuthProfile>[0]["selected"];
}) {
  const { params } = input;
  return cliBackendAcceptsAuthProfileForwarding({
    provider: input.executionProvider,
    config: params.cfgWithAgentDefaults,
    agentId: params.agentId,
  })
    ? await resolveCliExecutionAuthProfile({
        cliExecutionProvider: input.executionProvider,
        authProfileProvider: input.provider,
        config: params.cfgWithAgentDefaults,
        agentDir: params.agentDir,
        sessionBinding: input.binding,
        selected: input.selected,
      })
    : undefined;
}

/** Retain the selected account's session restriction through dispatch. */
export async function prepareCronCliCandidateAuth(
  input: Parameters<typeof resolveCronCliAuthProfile>[0] & {
    sessionTarget: Parameters<typeof bindRuntimeAuthProfileExecution>[1];
  },
) {
  const { params } = input;
  const profile = await resolveCronCliAuthProfile(input);
  const authProfileId = profile?.kind === "forwarded" ? profile.profileId : undefined;
  return bindRuntimeAuthProfileExecution(
    { authProfileId },
    input.sessionTarget,
    params.cronSession.sessionEntry,
    profile?.profileId,
    "writable",
  );
}
