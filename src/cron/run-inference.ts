import { CliExecutionAuthProfileError } from "../agents/cli-execution-auth.js";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type CronInferenceBinding,
  describeCronInferenceBinding,
  resolveCronRuntimeSessionEntry,
} from "./inference-binding.js";

type CronPinnedRunParams = Pick<
  RunEmbeddedAgentInternalParams,
  | "authProfileId"
  | "authProfileBinding"
  | "allowAuthProfileFallback"
  | "onSuccessfulAuthProfile"
  | "authProfileIdSource"
>;

/** Another provider selects live: the job's selected profile names the recorded account only. */
type CronLiveRunParams = Pick<RunEmbeddedAgentInternalParams, "scheduledLiveProviderAuth"> & {
  authProfileId: undefined;
  authProfileIdSource: undefined;
};

/**
 * A job records the account for its own provider only. Candidates on that provider run on
 * exactly that account; candidates on any other provider (configured fallbacks) select their
 * credentials live, the way an interactive run does.
 */
export type CronRunInference = {
  runParams: (provider: string) => CronPinnedRunParams | CronLiveRunParams;
  /** The session entry a candidate resolves its runtime from: the captured runtime, if any. */
  runtimeSessionEntry: <T extends { agentRuntimeOverride?: string; agentHarnessId?: string }>(
    entry: T,
    provider: string,
  ) => T | { agentRuntimeOverride: string };
  /** Refuses a candidate on the recorded provider that can't run on the recorded account. */
  assertCandidate: (provider: string, cliExecution: boolean, runtime?: string) => void;
  /** Rechecks the recorded account before a candidate's credential or transport effects. */
  assertCurrent: (provider: string) => void;
  /**
   * On the recorded provider, a CLI candidate runs only when its backend forwards exactly the
   * recorded account; `resolve` is the selector interactive CLI turns use. Other providers use
   * `live`, the interactive selection.
   */
  resolveCliAuthProfile: (
    provider: string,
    resolve: (selected: {
      authProfileId: string;
      authProfileIdSource: "user";
    }) => Promise<string | undefined>,
    live: () => Promise<string | undefined>,
  ) => Promise<string | undefined>;
  dispose: () => void;
};

function jobLabel(job: { id: string; name?: string }) {
  return job.name?.trim() ? `"${job.name.trim()}" (${job.id})` : job.id;
}

// Names the stored account, its captured runtime and the candidate that cannot use them.
function incompatibleCandidateError(params: {
  job: { id: string; name?: string };
  binding: CronInferenceBinding;
  provider: string;
  runtime?: string;
  cliExecution: boolean;
  cause?: unknown;
}): Error {
  const { binding } = params;
  const reason =
    binding.runtime && params.runtime && params.runtime !== binding.runtime
      ? `That account was recorded for runtime ${binding.runtime}, which this run can no longer use.`
      : params.cliExecution
        ? "The selected runtime signs in through its own CLI login and can't use that account."
        : "";
  return new Error(
    `Automation ${jobLabel(params.job)} runs ${params.provider} on ${describeCronInferenceBinding(binding)}${params.runtime ? ` and can't run it on runtime ${params.runtime}` : ""}. ` +
      (reason ? `${reason} ` : "") +
      `To choose an account explicitly: openclaw automations edit ${params.job.id} --model <provider/model>@<profileId> (list accounts: openclaw models auth list).`,
    params.cause === undefined ? undefined : { cause: params.cause },
  );
}

/** Both Cron execution paths keep the recorded account bound through turn settlement. */
export async function prepareCronRunInference(params: {
  job: { id: string; name?: string };
  binding?: CronInferenceBinding;
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<CronRunInference | undefined> {
  const { binding, job } = params;
  if (!binding) {
    return undefined;
  }
  const { acquireCronInferenceAuthorization } = await import("./inference-binding.runtime.js");
  // A replaced or removed account refuses only the candidates on its provider, when the chain
  // reaches them; configured fallbacks on other providers still run.
  let authorization: Awaited<ReturnType<typeof acquireCronInferenceAuthorization>> | undefined;
  let unavailable: unknown;
  try {
    authorization = await acquireCronInferenceAuthorization({
      binding,
      job,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
  } catch (error) {
    unavailable = error;
  }
  const current = () => {
    if (!authorization) {
      throw unavailable;
    }
    return authorization;
  };
  const pinned: CronPinnedRunParams = {
    authProfileId: binding.profileId,
    authProfileBinding: {
      profileId: binding.profileId,
      authRequirement: binding.authRequirement,
      assertCurrent: () => current().assertCurrent(),
      revalidate: () => current().revalidate(),
    },
    allowAuthProfileFallback: false,
    onSuccessfulAuthProfile: (profileId) => {
      if (profileId !== binding.profileId) {
        throw new Error("Automation inference account changed during execution.");
      }
    },
    authProfileIdSource: binding.source,
  };
  const live: CronLiveRunParams = {
    scheduledLiveProviderAuth: true,
    authProfileId: undefined,
    authProfileIdSource: undefined,
  };
  // The last admitted candidate's runtime, named when its CLI backend refuses the account.
  let candidateRuntime: string | undefined;
  return {
    runParams: (provider) => (provider === binding.provider ? pinned : live),
    runtimeSessionEntry: (entry, provider) =>
      resolveCronRuntimeSessionEntry(binding, entry, provider),
    assertCandidate(provider, cliExecution, runtime) {
      if (provider !== binding.provider) {
        return;
      }
      // A binding without a captured runtime keeps the runtime its run derives.
      if (binding.runtime && runtime && runtime !== binding.runtime) {
        throw incompatibleCandidateError({ job, binding, provider, runtime, cliExecution });
      }
      candidateRuntime = runtime ?? candidateRuntime;
      // CLI candidates finish this check in resolveCliAuthProfile, before the process starts.
      current().assertCurrent();
    },
    assertCurrent(provider) {
      if (provider === binding.provider) {
        current().assertCurrent();
      }
    },
    async resolveCliAuthProfile(provider, resolve, liveSelection) {
      if (provider !== binding.provider) {
        return await liveSelection();
      }
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
          job,
          binding,
          provider,
          runtime: candidateRuntime,
          cliExecution: true,
          cause: error,
        });
      }
      if (profileId !== binding.profileId) {
        throw incompatibleCandidateError({
          job,
          binding,
          provider,
          runtime: candidateRuntime,
          cliExecution: true,
        });
      }
      current().assertCurrent();
      return profileId;
    },
    dispose: () => authorization?.dispose(),
  };
}
