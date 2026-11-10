import { CliExecutionAuthProfileError } from "../agents/cli-execution-auth.js";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import { recordModelFallbackStop } from "../agents/model-fallback-stop.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelKey } from "../shared/model-key.js";
import {
  type CronInferenceBinding,
  type CronInferenceGrants,
  describeCronInferenceBinding,
  resolveCronCandidateInferenceBinding,
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
      "Select a model compatible with the recorded account, or explicitly select an account with " +
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
  const authorization = await acquireCronInferenceAuthorization({ ...params, binding }).catch(
    stopInferenceFallback,
  );
  const assertCurrent = () => {
    try {
      authorization.assertCurrent();
    } catch (error) {
      stopInferenceFallback(error);
    }
  };
  const revalidate = async () => {
    try {
      await authorization.revalidate();
    } catch (error) {
      stopInferenceFallback(error);
    }
  };
  // The last admitted candidate's runtime, named when its CLI backend refuses the account.
  let candidateRuntime: string | undefined;
  return {
    runParams: {
      authProfileId: binding.profileId,
      authProfileBinding: {
        profileId: binding.profileId,
        authRequirement: binding.authRequirement,
        assertCurrent,
        revalidate,
      },
      allowAuthProfileFallback: false,
      onSuccessfulAuthProfile: (profileId) => {
        if (profileId !== binding.profileId) {
          stopInferenceFallback(
            new Error("Automation inference account changed during execution."),
          );
        }
      },
      authProfileIdSource: binding.source,
    },
    runtimeSessionEntry: (entry) => resolveCronRuntimeSessionEntry(binding, entry),
    assertCandidate(provider, cliExecution, runtime) {
      // A binding without a captured runtime keeps the runtime its run derives.
      if (provider !== binding.provider) {
        // An unapproved provider is skippable; it does not revoke the stored account.
        throw incompatibleCandidateError({ binding, provider, runtime, cliExecution });
      }
      if (binding.runtime && runtime && runtime !== binding.runtime) {
        stopInferenceFallback(
          incompatibleCandidateError({ binding, provider, runtime, cliExecution }),
        );
      }
      candidateRuntime = runtime ?? candidateRuntime;
      // CLI candidates finish this check in resolveCliAuthProfile, before the process starts.
      assertCurrent();
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
        stopInferenceFallback(
          incompatibleCandidateError({
            binding,
            provider: binding.provider,
            runtime: candidateRuntime,
            cliExecution: true,
            cause: error,
          }),
        );
      }
      if (profileId !== binding.profileId) {
        stopInferenceFallback(
          incompatibleCandidateError({
            binding,
            provider: binding.provider,
            runtime: candidateRuntime,
            cliExecution: true,
          }),
        );
      }
      assertCurrent();
      return profileId;
    },
    dispose: authorization.dispose,
  };
}

function stopInferenceFallback(error: unknown): never {
  const failure = error instanceof Error ? error : new Error(String(error));
  recordModelFallbackStop(failure);
  throw failure;
}

/** One run owns its captured candidate leases; missing grants never enter auth preparation. */
export function createCronRunInferenceCandidates(params: {
  binding?: CronInferenceBinding;
  grants?: CronInferenceGrants;
  primary: { provider: string; model: string };
  cfg: OpenClawConfig;
  agentDir: string;
}) {
  const leases = new Map<string, CronRunInference | undefined>();
  const primaryKey = modelKey(params.primary.provider, params.primary.model);
  const bindingFor = (provider: string, model: string) =>
    resolveCronCandidateInferenceBinding(params, provider, model);
  // Losing any admitted account ends the run; another grant cannot replace that authority.
  const assertCurrent = () => {
    for (const lease of leases.values()) {
      lease?.runParams.authProfileBinding?.assertCurrent();
    }
  };
  const admit = async (provider: string, model: string): Promise<string | undefined> => {
    assertCurrent();
    const key = modelKey(provider, model);
    if (params.grants !== undefined && key !== primaryKey && !Object.hasOwn(params.grants, key)) {
      return `Automation candidate ${key} has no recorded account authorization; review its model policy to enable failover.`;
    }
    const binding = bindingFor(provider, model);
    if (binding && binding.provider !== provider) {
      return incompatibleCandidateError({ binding, provider, cliExecution: false }).message;
    }
    if (!leases.has(key)) {
      leases.set(key, await prepareCronRunInference({ ...params, binding }));
    }
    await leases.get(key)?.runParams.authProfileBinding?.revalidate();
    assertCurrent();
    return undefined;
  };
  return {
    bindingFor,
    admit,
    async prepare(provider: string, model: string) {
      // Dispatch enforces admission too: bypassing eager preparation cannot run unbound.
      const reason = await admit(provider, model);
      if (reason) {
        throw new Error(reason);
      }
      const lease = leases.get(modelKey(provider, model));
      const account = lease?.runParams.authProfileBinding;
      if (!lease || !account) {
        return lease;
      }
      // Both runtime adapters carry this assertion through awaited preparation to their
      // final HTTP/process effect. Keep raw leases in the map to avoid recursive guards.
      return {
        ...lease,
        runParams: {
          ...lease.runParams,
          authProfileBinding: {
            ...account,
            assertCurrent,
            async revalidate() {
              await account.revalidate();
              assertCurrent();
            },
          },
        },
        assertCandidate(candidateProvider: string, cliExecution: boolean, runtime?: string) {
          assertCurrent();
          lease.assertCandidate(candidateProvider, cliExecution, runtime);
        },
        async resolveCliAuthProfile(
          resolve: Parameters<CronRunInference["resolveCliAuthProfile"]>[0],
        ) {
          const profileId = await lease.resolveCliAuthProfile(resolve);
          assertCurrent();
          return profileId;
        },
      };
    },
    dispose: () => {
      for (const lease of leases.values()) {
        lease?.dispose();
      }
      leases.clear();
    },
  };
}
