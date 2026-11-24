import { WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { AgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { getRepositoryIntegration } from "../../plugins/repository-integration-runtime.js";
import type { PublicationSessionIdentity } from "../github-publication-session.types.js";
import { StaleWorkerBuildError } from "./admission.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import {
  bindWorkerTurnGitHubGrant,
  type WorkerTurnExecutionIdentityStore,
} from "./placement-turn-claim-events.js";
import type { WorkerGitHubBindingGrant } from "./worker-github-binding-contract.js";
import {
  prepareDiscoveredWorkerGitHubBindingGrant,
  type prepareGitHubPublicationFact,
} from "./worker-github-binding.js";
import { prepareWorkerGitHubExecutionGrant } from "./worker-github-execution-identity.js";

/** Attach the background fact to this admitted turn without running identity discovery. */
export async function bindWorkerGitHubTurn(params: {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  session: PublicationSessionIdentity;
  fact: Awaited<ReturnType<typeof prepareGitHubPublicationFact>>;
  sessionTarget: AgentRunSessionTarget;
  store: WorkerTurnExecutionIdentityStore;
  claim: WorkerSessionTurnClaim;
  protocolFeatures: readonly string[];
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  if (getRepositoryIntegration()) {
    if (!params.protocolFeatures.includes(WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE)) {
      throw new StaleWorkerBuildError();
    }
    const grant = await prepareWorkerGitHubExecutionGrant({
      ...params.session,
      sessionTarget: params.sessionTarget,
      operatorAuthority: params.operatorAuthority,
      signal: params.signal,
      assertCurrent: () => {
        params.assertCurrent();
        return true;
      },
    });
    if (grant) {
      try {
        params.assertCurrent();
        bindWorkerTurnGitHubGrant(params.store, params.claim, grant);
      } catch (error) {
        await grant.revoke();
        throw error;
      }
    }
    return grant;
  }
  const { github, identity, workspaceKey: expectedWorkspace } = params.fact ?? {};
  if (!github || !identity || !expectedWorkspace) {
    return undefined;
  }
  if (!params.protocolFeatures.includes(WORKER_GITHUB_REFRESH_PROTOCOL_FEATURE)) {
    throw new StaleWorkerBuildError();
  }
  const preparing = prepareDiscoveredWorkerGitHubBindingGrant({
    ...params.session,
    operatorAuthority: params.operatorAuthority,
    github,
    identity,
    workspaceKey: expectedWorkspace,
    sessionTarget: params.sessionTarget,
    signal: params.signal,
    assertCurrent: params.assertCurrent,
  }).then((grant) => {
    if (params.signal.aborted) {
      void grant.revoke();
    }
    return grant;
  });
  const grant = await raceNodeWorkerOperation(preparing, params.signal);
  try {
    bindWorkerTurnGitHubGrant(params.store, params.claim, grant);
  } catch (error) {
    await grant.revoke();
    throw error;
  }
  return grant;
}

export type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";
