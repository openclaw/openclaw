import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import {
  ONBOARDING_RECOMMENDATIONS_STATE_KEY_PREFIX,
  prepareOnboardingRecommendationOffer,
  prepareOnboardingRecommendationPending,
  type OnboardingRecommendationsRecord,
  type WriteOnboardingRecommendationsOfferParams,
  type AcknowledgeOnboardingRecommendationsParams,
  type UpdatePendingOnboardingRecommendationsParams,
  type ClearPendingOnboardingRecommendationsParams,
} from "./onboarding-recommendations.contract.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "./openclaw-state-worker-store.js";

export type {
  OnboardingRecommendationMatch,
  OnboardingRecommendationsRecord,
} from "./onboarding-recommendations.contract.js";

export function createOnboardingRecommendationsStore(params: {
  workspaceDir: string;
  database?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
}) {
  // Doctor owns the one-time `primary` migration; a runtime fallback would recreate
  // cross-workspace reads. Every operation stays bound to one canonical workspace key.
  const { workspaceKey } = resolveWorkspaceStateIdentity(params.workspaceDir);
  const configKey = `${ONBOARDING_RECOMMENDATIONS_STATE_KEY_PREFIX}${workspaceKey}`;
  const database = params.database ?? {};
  return {
    read: async (): Promise<OnboardingRecommendationsRecord | null> => {
      const result = await executeExistingOpenClawStateRead(database, {
        type: "onboardingRecommendations.read",
        configKey,
      });
      if (result === undefined) {
        return null;
      }
      return result.record;
    },
    writeOffer: (offer: WriteOnboardingRecommendationsOfferParams) => {
      const captured = prepareOnboardingRecommendationOffer(offer);
      const context = captureOpenClawStateWorkerContext(database);
      return executeOpenClawStateWorker(context, {
        type: "onboardingRecommendations.writeOffer",
        input: { workspaceKey, params: captured },
      });
    },
    acknowledge: (options: AcknowledgeOnboardingRecommendationsParams = {}) => {
      const context = captureOpenClawStateWorkerContext(database);
      const captured = { ...options, nowMs: options.nowMs ?? Date.now() };
      return executeOpenClawStateWorker(context, {
        type: "onboardingRecommendations.acknowledge",
        input: { workspaceKey, params: captured },
      });
    },
    updatePending: (options: UpdatePendingOnboardingRecommendationsParams) => {
      const captured = prepareOnboardingRecommendationPending(options);
      const context = captureOpenClawStateWorkerContext(database);
      return executeOpenClawStateWorker(context, {
        type: "onboardingRecommendations.updatePending",
        input: { workspaceKey, params: captured },
      });
    },
    clearPending: (options: ClearPendingOnboardingRecommendationsParams) => {
      const context = captureOpenClawStateWorkerContext(database);
      return executeOpenClawStateWorker(context, {
        type: "onboardingRecommendations.clearPending",
        input: { workspaceKey, params: options },
      });
    },
    clear: () => {
      return executeOpenClawStateWorker(captureOpenClawStateWorkerContext(database), {
        type: "onboardingRecommendations.clear",
        input: { workspaceKey },
      });
    },
  };
}

export type OnboardingRecommendationsStore = ReturnType<
  typeof createOnboardingRecommendationsStore
>;
