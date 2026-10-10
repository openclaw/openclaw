import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../../agents/cli-execution-auth.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { resolveRunAuthProfile } from "../../auto-reply/reply/agent-runner-auth-profile.js";
import { readConfiguredModelAuthProfileProvider } from "../../config/sessions/auth-profile-override-provenance.js";
import { bindRuntimeAuthProfileExecution } from "../../config/sessions/session-entry-current-runtime.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "runSessionKey" | "cronSession"
  >,
) {
  return (provider: string, model: string, sessionRuntimeOverride: string | undefined) => {
    const executionProvider = sessionRuntimeOverride
      ? isCliProvider(sessionRuntimeOverride, params.cfgWithAgentDefaults)
        ? sessionRuntimeOverride
        : provider
      : (resolveCliRuntimeExecutionProvider({
          provider,
          cfg: params.cfgWithAgentDefaults,
          agentId: params.agentId,
          modelId: model,
        }) ?? provider);
    const runtime =
      sessionRuntimeOverride ??
      resolveEffectiveAgentRuntime({
        cfg: params.cfgWithAgentDefaults,
        provider,
        modelId: model,
        agentId: params.agentId,
        sessionKey: params.runSessionKey,
        sessionEntry: params.cronSession.sessionEntry,
      });
    return {
      sessionRuntimeOverride,
      executionProvider,
      cliExecution: isCliProvider(executionProvider, params.cfgWithAgentDefaults),
      runtime,
    };
  };
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

/** Resolve the actual CLI account and retain its session restriction through dispatch. */
export function prepareCronCliCandidateAuth(input: {
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "agentDir" | "cronSession"
  >;
  sessionTarget: Parameters<typeof bindRuntimeAuthProfileExecution>[1];
  executionProvider: string;
  provider: string;
  binding: Parameters<typeof resolveCliExecutionAuthProfileId>[0]["sessionBinding"];
  selected: Parameters<typeof resolveCliExecutionAuthProfileId>[0]["selected"];
}) {
  const { params } = input;
  const authProfileId = cliBackendAcceptsAuthProfileForwarding({
    provider: input.executionProvider,
    config: params.cfgWithAgentDefaults,
    agentId: params.agentId,
  })
    ? resolveCliExecutionAuthProfileId({
        cliExecutionProvider: input.executionProvider,
        authProfileProvider: input.provider,
        config: params.cfgWithAgentDefaults,
        agentDir: params.agentDir,
        sessionBinding: input.binding,
        selected: input.selected,
      })
    : undefined;
  return bindRuntimeAuthProfileExecution(
    { authProfileId },
    input.sessionTarget,
    params.cronSession.sessionEntry,
    authProfileId,
    "writable",
  );
}
