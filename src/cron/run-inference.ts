import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronInferenceBinding } from "./inference-binding.js";

export type CronRunInference = {
  runParams: Pick<
    RunEmbeddedAgentInternalParams,
    | "authProfileId"
    | "authProfileBinding"
    | "allowAuthProfileFallback"
    | "onSuccessfulAuthProfile"
    | "authProfileIdSource"
  >;
  assertCandidate: (provider: string, cliExecution: boolean) => void;
  /**
   * A CLI candidate may run only when its backend forwards exactly the recorded account,
   * selected explicitly; `resolve` is the same selector interactive CLI turns use.
   */
  resolveCliAuthProfile: (
    resolve: (selected: {
      authProfileId: string;
      authProfileIdSource: "user";
    }) => Promise<string | undefined>,
  ) => Promise<string>;
  dispose: () => void;
};

function incompatibleCandidateError(cliExecution: boolean, cause?: unknown): Error {
  return new Error(
    "Automation candidate is incompatible with its recorded inference account and route. " +
      (cliExecution
        ? "The selected runtime uses a CLI login that cannot use this job's stored account. "
        : "The selected model uses a different provider from this job's stored account. ") +
      "Select a model compatible with the recorded account, or explicitly select a stored account with " +
      "openclaw automations edit <jobId> --model <provider/model>@<profileId>.",
    cause === undefined ? undefined : { cause },
  );
}

/** Both Cron execution paths keep the recorded account bound through turn settlement. */
export async function prepareCronRunInference(params: {
  binding?: CronInferenceBinding;
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<CronRunInference | undefined> {
  const { binding } = params;
  if (!binding) {
    return undefined;
  }
  const { acquireCronInferenceAuthorization } = await import("./inference-binding.runtime.js");
  const authorization = await acquireCronInferenceAuthorization({ ...params, binding });
  return {
    runParams: {
      authProfileId: binding.profileId,
      authProfileBinding: {
        profileId: binding.profileId,
        authRequirement: binding.authRequirement,
        assertCurrent: authorization.assertCurrent,
        revalidate: authorization.revalidate,
      },
      allowAuthProfileFallback: false,
      onSuccessfulAuthProfile: (profileId) => {
        if (profileId !== binding.profileId) {
          throw new Error("Automation inference account changed during execution.");
        }
      },
      authProfileIdSource: binding.source,
    },
    assertCandidate(provider, cliExecution) {
      if (provider !== binding.provider) {
        throw incompatibleCandidateError(cliExecution);
      }
      // CLI candidates finish this check in resolveCliAuthProfile, before the process starts.
      authorization.assertCurrent();
    },
    async resolveCliAuthProfile(resolve) {
      let profileId: string | undefined;
      try {
        profileId = await resolve({
          authProfileId: binding.profileId,
          authProfileIdSource: "user",
        });
      } catch (error) {
        throw incompatibleCandidateError(true, error);
      }
      if (profileId !== binding.profileId) {
        throw incompatibleCandidateError(true);
      }
      authorization.assertCurrent();
      return profileId;
    },
    dispose: authorization.dispose,
  };
}
