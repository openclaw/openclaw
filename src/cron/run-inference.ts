import { CliExecutionAuthProfileError } from "../agents/cli-execution-auth.js";
import { resolveBundledCliBackendAuthPolicy } from "../agents/cli-runner/cli-backend-auth-policy.js";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import { FailoverError } from "../agents/failover/error.js";
import { resolveProviderModelAuthPolicy } from "../agents/model-auth-policy.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronStoredJob } from "./types.js";

type CronModelPin = { provider: string; profileId: string; runtime?: string };

export function resolveCronModelPin(
  job: Pick<CronStoredJob, "payload" | "runtimeAuthority">,
  cfg: OpenClawConfig,
  agentId: string,
): CronModelPin | undefined {
  if (
    job.runtimeAuthority ||
    job.payload.kind !== "agentTurn" ||
    !job.payload.model ||
    !splitTrailingAuthProfile(job.payload.model).profile
  ) {
    return undefined;
  }
  const selection = resolveSimpleCompletionSelectionForAgent({
    cfg,
    agentId,
    modelRef: job.payload.model,
  });
  return selection?.profileId
    ? {
        provider: selection.provider,
        profileId: selection.profileId,
        runtime: job.payload.modelRuntime ?? undefined,
      }
    : undefined;
}

export function resolveCronRuntimeSessionEntry<
  T extends { agentRuntimeOverride?: string; agentHarnessId?: string },
>(pin: CronModelPin | undefined, entry: T, provider: string): T | { agentRuntimeOverride: string } {
  return pin?.runtime && provider === pin.provider ? { agentRuntimeOverride: pin.runtime } : entry;
}

type CronPinnedRunParams = Pick<
  RunEmbeddedAgentInternalParams,
  | "authProfileId"
  | "authProfileBinding"
  | "allowAuthProfileFallback"
  | "onSuccessfulAuthProfile"
  | "authProfileIdSource"
>;

/** Another provider selects live: the job's selected profile names the pinned account only. */
type CronLiveRunParams = {
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
  /** The session entry a candidate resolves its runtime from: the pinned runtime, if any. */
  runtimeSessionEntry: <T extends { agentRuntimeOverride?: string; agentHarnessId?: string }>(
    entry: T,
    provider: string,
  ) => T | { agentRuntimeOverride: string };
  /** Refuses a candidate on the pinned provider that can't run on the pinned account. */
  assertCandidate: (provider: string, cliExecution: boolean, runtime?: string) => void;
  /** Rechecks the pinned account before a candidate's credential or transport effects. */
  assertCurrent: (provider: string) => void;
  /**
   * On the pinned provider, a CLI candidate runs only when its backend forwards exactly the
   * pinned account; `resolve` is the selector interactive CLI turns use. Other providers use
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
  usesNativeCliAccount: (provider: string, runtime: string) => boolean;
  dispose: () => void;
};

function jobLabel(job: { id: string; name?: string }) {
  return job.name?.trim() ? `"${job.name.trim()}" (${job.id})` : job.id;
}

// Names the stored account, its captured runtime and the candidate that cannot use them.
function incompatibleCandidateError(params: {
  job: { id: string; name?: string };
  binding: CronModelPin;
  provider: string;
  runtime?: string;
  cliExecution: boolean;
  cause?: unknown;
}): Error {
  const { binding } = params;
  const reason =
    binding.runtime && params.runtime && params.runtime !== binding.runtime
      ? `The job pins runtime ${binding.runtime}, which this run can no longer use.`
      : params.cliExecution
        ? "The selected runtime signs in through its own CLI login and can't use that account."
        : "";
  return new Error(
    `Automation ${jobLabel(params.job)} runs ${params.provider} on account ${binding.profileId}${params.runtime ? ` and can't run it on runtime ${params.runtime}` : ""}. ` +
      (reason ? `${reason} ` : "") +
      `To choose an account explicitly: openclaw automations edit ${params.job.id} --model <provider/model>@<profileId> (list accounts: openclaw models auth list).`,
    params.cause === undefined ? undefined : { cause: params.cause },
  );
}

/** Both Cron execution paths keep the pinned account bound through turn settlement. */
export async function prepareCronRunInference(params: {
  job: Pick<CronStoredJob, "id" | "name" | "payload" | "runtimeAuthority">;
  agentId: string;
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<CronRunInference | undefined> {
  const { job } = params;
  const binding = resolveCronModelPin(job, params.cfg, params.agentId);
  if (!binding) {
    return undefined;
  }
  const { captureAuthProfileAuthorization } =
    await import("../agents/auth-profiles/authorization.js");
  const { loadAuthProfileStoreForRuntimeAsync } =
    await import("../agents/auth-profiles/store-runtime.js");
  const usesNativeCliAccount = (provider: string, runtime: string) =>
    provider === binding.provider &&
    Boolean(
      resolveBundledCliBackendAuthPolicy(runtime)?.nativeAuthProfileIds?.includes(
        binding.profileId,
      ),
    );
  const nativeOnly = usesNativeCliAccount(binding.provider, "claude-cli");
  // A replaced or removed account refuses only the candidates on its provider, when the chain
  // reaches them; configured fallbacks on other providers still run.
  let authorization: Awaited<ReturnType<typeof captureAuthProfileAuthorization>> | undefined;
  let authRequirement:
    | NonNullable<CronPinnedRunParams["authProfileBinding"]>["authRequirement"]
    | undefined;
  let unavailable: unknown;
  if (!nativeOnly) {
    try {
      authorization = await captureAuthProfileAuthorization({
        profileId: binding.profileId,
        cfg: params.cfg,
        agentDir: params.agentDir,
        assertCurrent() {},
      });
      const store = await loadAuthProfileStoreForRuntimeAsync(params.agentDir, {
        profileId: binding.profileId,
        readOnly: true,
        allowKeychainPrompt: false,
      });
      const credential = store.profiles[binding.profileId];
      authRequirement =
        (credential &&
          resolveProviderModelAuthPolicy({
            provider: binding.provider,
            mode: credential.type,
            authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
          }).authRequirement) ||
        undefined;
      if (!authRequirement) {
        throw new Error("Pinned account has no compatible authentication route.");
      }
    } catch (error) {
      authorization?.dispose();
      authorization = undefined;
      unavailable = new FailoverError(
        `Automation ${jobLabel(job)} cannot use pinned account ${binding.profileId}: it is unavailable or no longer authorized. Sign in again or edit the job to select another account.`,
        { cause: error, reason: "auth", provider: binding.provider, profileId: binding.profileId },
      );
    }
  }
  const current = () => {
    if (!authorization) {
      throw unavailable;
    }
    return authorization;
  };
  const pinned: CronPinnedRunParams = {
    authProfileId: binding.profileId,
    authProfileBinding: authRequirement
      ? {
          profileId: binding.profileId,
          authRequirement,
          assertCurrent: () => current().assertCurrent(),
          revalidate: () => current().revalidate(),
        }
      : undefined,
    allowAuthProfileFallback: false,
    onSuccessfulAuthProfile: (profileId) => {
      if (profileId !== binding.profileId) {
        throw new Error("Automation inference account changed during execution.");
      }
    },
    authProfileIdSource: "user",
  };
  const live: CronLiveRunParams = {
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
      if (nativeOnly) {
        if (!cliExecution || (runtime && !usesNativeCliAccount(provider, runtime))) {
          throw incompatibleCandidateError({ job, binding, provider, runtime, cliExecution });
        }
        return;
      }
      current().assertCurrent();
    },
    assertCurrent(provider) {
      if (provider === binding.provider && !nativeOnly) {
        current().assertCurrent();
      }
    },
    async resolveCliAuthProfile(provider, resolve, liveSelection) {
      if (provider !== binding.provider) {
        return await liveSelection();
      }
      if (nativeOnly) {
        if (!candidateRuntime || !usesNativeCliAccount(provider, candidateRuntime)) {
          throw incompatibleCandidateError({
            job,
            binding,
            provider,
            runtime: candidateRuntime,
            cliExecution: true,
          });
        }
        return undefined;
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
    usesNativeCliAccount,
    dispose: () => authorization?.dispose(),
  };
}
