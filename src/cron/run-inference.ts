import { CliExecutionAuthProfileError } from "../agents/cli-execution-auth.js";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type CronInferenceAccount,
  type CronInferenceBinding,
  describeCronInferenceBinding,
  resolveCronInferenceAccount,
  resolveCronRuntimeSessionEntry,
} from "./inference-binding.js";

type CronRunInferenceRunParams = Pick<
  RunEmbeddedAgentInternalParams,
  | "authProfileId"
  | "authProfileBinding"
  | "allowAuthProfileFallback"
  | "onSuccessfulAuthProfile"
  | "authProfileIdSource"
>;

export type CronRunInference = {
  /** Run params pinned to the recorded account of the candidate's provider. */
  runParams: (provider: string) => CronRunInferenceRunParams;
  /** The session entry candidates resolve their runtime from: the captured runtime, if any. */
  runtimeSessionEntry: <T extends { agentRuntimeOverride?: string; agentHarnessId?: string }>(
    entry: T,
    provider: string,
  ) => T | { agentRuntimeOverride: string };
  /** The drift guard: one refusal for every embedded and CLI candidate. */
  assertCandidate: (provider: string, cliExecution: boolean, runtime?: string) => void;
  /**
   * A CLI candidate may run only when its backend forwards exactly the recorded account,
   * selected explicitly; `resolve` is the same selector interactive CLI turns use.
   */
  resolveCliAuthProfile: (
    provider: string,
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
  account: CronInferenceAccount | undefined;
  provider: string;
  runtime?: string;
  cliExecution: boolean;
  cause?: unknown;
}): Error {
  const { binding, account } = params;
  const recorded = account ?? binding;
  const reason = !account
    ? `The selected model uses a different provider from this job's stored account, and no fallback account is recorded for provider ${params.provider}. `
    : account.runtime && params.runtime && params.runtime !== account.runtime
      ? `The account was captured for runtime ${account.runtime}, which this run can no longer use. `
      : params.cliExecution
        ? "The selected runtime uses a CLI login that cannot use this job's stored account. "
        : "";
  return new Error(
    `Automation candidate ${params.provider}${params.runtime ? ` on runtime ${params.runtime}` : ""} is incompatible with its recorded inference account and route (${describeCronInferenceBinding(recorded)}). ` +
      reason +
      "Select a model compatible with the recorded account, or explicitly select an account with " +
      "openclaw automations edit <jobId> --model <provider/model>@<profileId>." +
      (account
        ? ""
        : " For a fallback model, record its provider's account with openclaw doctor --fix or " +
          "openclaw automations edit <jobId> --fallbacks <list>."),
    params.cause === undefined ? undefined : { cause: params.cause },
  );
}

type AccountAuthorization =
  | { ok: true; authorization: Awaited<ReturnType<typeof acquireAuthorization>> }
  | { ok: false; error: unknown };

async function acquireAuthorization(params: {
  binding: CronInferenceAccount;
  cfg: OpenClawConfig;
  agentDir: string;
}) {
  const { acquireCronInferenceAuthorization } = await import("./inference-binding.runtime.js");
  return acquireCronInferenceAuthorization(params);
}

/** Both Cron execution paths keep each recorded account bound through turn settlement. */
export async function prepareCronRunInference(params: {
  binding?: CronInferenceBinding;
  cfg: OpenClawConfig;
  agentDir: string;
}): Promise<CronRunInference | undefined> {
  const { binding } = params;
  if (!binding) {
    return undefined;
  }
  // The primary account must be current before the run starts.
  const primary = await acquireAuthorization({ ...params, binding });
  const authorizations = new Map<string, AccountAuthorization>([
    [binding.provider, { ok: true, authorization: primary }],
  ]);
  // A fallback account that was replaced or revoked refuses only its own candidates, at the
  // point the chain reaches them; it never blocks the primary.
  for (const account of binding.fallbackAccounts ?? []) {
    try {
      authorizations.set(account.provider, {
        ok: true,
        authorization: await acquireAuthorization({ ...params, binding: account }),
      });
    } catch (error) {
      authorizations.set(account.provider, { ok: false, error });
    }
  }
  const disposeAll = () => {
    for (const entry of authorizations.values()) {
      if (entry.ok) {
        entry.authorization.dispose();
      }
    }
  };
  const authorizationFor = (account: CronInferenceAccount) => {
    const entry = authorizations.get(account.provider);
    if (!entry) {
      throw new Error("Automation inference account authorization is missing.");
    }
    if (!entry.ok) {
      throw entry.error;
    }
    return entry.authorization;
  };
  // The last admitted candidate's runtime, named when its CLI backend refuses the account.
  let candidateRuntime: string | undefined;
  return {
    runParams(provider) {
      // Unrecorded providers keep the primary's pin; assertCandidate refuses them first.
      const account = resolveCronInferenceAccount(binding, provider) ?? binding;
      const isPrimary = account === binding;
      return {
        authProfileId: account.profileId,
        authProfileBinding: {
          profileId: account.profileId,
          authRequirement: account.authRequirement,
          assertCurrent: () => authorizationFor(account).assertCurrent(),
          revalidate: () => authorizationFor(account).revalidate(),
        },
        allowAuthProfileFallback: false,
        onSuccessfulAuthProfile: (profileId) => {
          if (profileId !== account.profileId) {
            throw new Error("Automation inference account changed during execution.");
          }
        },
        authProfileIdSource: isPrimary ? binding.source : "auto",
      };
    },
    runtimeSessionEntry: (entry, provider) =>
      resolveCronRuntimeSessionEntry(
        resolveCronInferenceAccount(binding, provider) ?? binding,
        entry,
      ),
    assertCandidate(provider, cliExecution, runtime) {
      const account = resolveCronInferenceAccount(binding, provider);
      // A binding without a captured runtime keeps the runtime its run derives.
      if (!account || (account.runtime && runtime && runtime !== account.runtime)) {
        throw incompatibleCandidateError({ binding, account, provider, runtime, cliExecution });
      }
      candidateRuntime = runtime ?? candidateRuntime;
      // CLI candidates finish this check in resolveCliAuthProfile, before the process starts.
      authorizationFor(account).assertCurrent();
    },
    async resolveCliAuthProfile(provider, resolve) {
      const account = resolveCronInferenceAccount(binding, provider);
      if (!account) {
        throw incompatibleCandidateError({
          binding,
          account,
          provider,
          runtime: candidateRuntime,
          cliExecution: true,
        });
      }
      let profileId: string | undefined;
      try {
        profileId = await resolve({
          authProfileId: account.profileId,
          authProfileIdSource: "user",
        });
      } catch (error) {
        // Store and lifecycle failures retain their own recovery advice and terminal facts.
        if (!(error instanceof CliExecutionAuthProfileError)) {
          throw error;
        }
        throw incompatibleCandidateError({
          binding,
          account,
          provider,
          runtime: candidateRuntime,
          cliExecution: true,
          cause: error,
        });
      }
      if (profileId !== account.profileId) {
        throw incompatibleCandidateError({
          binding,
          account,
          provider,
          runtime: candidateRuntime,
          cliExecution: true,
        });
      }
      authorizationFor(account).assertCurrent();
      return profileId;
    },
    dispose: disposeAll,
  };
}
