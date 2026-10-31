import { CliExecutionAuthProfileError } from "../agents/cli-execution-auth.js";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type CronInferenceBinding,
  describeCronInferenceBinding,
  resolveCronRuntimeSessionEntry,
} from "./inference-binding.js";

export type CronRunInference = {
  runParams: Pick<
    RunEmbeddedAgentInternalParams,
    | "authProfileId"
    | "authProfileBinding"
    | "allowAuthProfileFallback"
    | "onSuccessfulAuthProfile"
    | "authProfileIdSource"
  >;
  /** The session entry candidates resolve their runtime from: the captured runtime, if any. */
  runtimeSessionEntry: <T extends { agentRuntimeOverride?: string; agentHarnessId?: string }>(
    entry: T,
  ) => T | { agentRuntimeOverride: string };
  /** The drift guard: one refusal for every embedded and CLI candidate. */
  assertCandidate: (provider: string, cliExecution: boolean, runtime?: string) => void;
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

// Names the stored account, its captured runtime and the candidate that cannot use them.
function incompatibleCandidateError(params: {
  binding: CronInferenceBinding;
  provider: string;
  runtime?: string;
  cliExecution: boolean;
  cause?: unknown;
}): Error {
  const { binding } = params;
  const reason =
    params.provider !== binding.provider
      ? "The selected model uses a different provider from this job's stored account. "
      : binding.runtime && params.runtime && params.runtime !== binding.runtime
        ? `The account was captured for runtime ${binding.runtime}, which this run can no longer use. `
        : params.cliExecution
          ? "The selected runtime uses a CLI login that cannot use this job's stored account. "
          : "";
  return new Error(
    `Automation candidate ${params.provider}${params.runtime ? ` on runtime ${params.runtime}` : ""} is incompatible with its recorded inference account and route (${describeCronInferenceBinding(binding)}). ` +
      reason +
      "Select a model compatible with the recorded account, or explicitly select a stored account with " +
      "openclaw automations edit <jobId> --model <provider/model>@<profileId>.",
    params.cause === undefined ? undefined : { cause: params.cause },
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
  // The last admitted candidate's runtime, named when its CLI backend refuses the account.
  let candidateRuntime: string | undefined;
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
    runtimeSessionEntry: (entry) => resolveCronRuntimeSessionEntry(binding, entry),
    assertCandidate(provider, cliExecution, runtime) {
      // A binding without a captured runtime keeps the runtime its run derives.
      if (
        provider !== binding.provider ||
        (binding.runtime && runtime && runtime !== binding.runtime)
      ) {
        throw incompatibleCandidateError({ binding, provider, runtime, cliExecution });
      }
      candidateRuntime = runtime ?? candidateRuntime;
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
        // Store and lifecycle failures retain their own recovery advice and terminal facts.
        if (!(error instanceof CliExecutionAuthProfileError)) {
          throw error;
        }
        throw incompatibleCandidateError({
          binding,
          provider: binding.provider,
          runtime: candidateRuntime,
          cliExecution: true,
          cause: error,
        });
      }
      if (profileId !== binding.profileId) {
        throw incompatibleCandidateError({
          binding,
          provider: binding.provider,
          runtime: candidateRuntime,
          cliExecution: true,
        });
      }
      authorization.assertCurrent();
      return profileId;
    },
    dispose: authorization.dispose,
  };
}
