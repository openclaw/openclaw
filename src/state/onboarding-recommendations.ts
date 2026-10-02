import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import {
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

export type OnboardingRecommendationsStore = {
  read: () => Promise<OnboardingRecommendationsRecord | null>;
  writeOffer: (
    params: WriteOnboardingRecommendationsOfferParams,
  ) => Promise<OnboardingRecommendationsRecord>;
  acknowledge: (
    params?: AcknowledgeOnboardingRecommendationsParams,
  ) => Promise<OnboardingRecommendationsRecord | null>;
  updatePending: (
    params: UpdatePendingOnboardingRecommendationsParams,
  ) => Promise<OnboardingRecommendationsRecord | null>;
  clearPending: (params: ClearPendingOnboardingRecommendationsParams) => Promise<boolean>;
  clear: () => Promise<boolean>;
};

export function createOnboardingRecommendationsStore(params: {
  workspaceDir: string;
  database?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
}): OnboardingRecommendationsStore {
  // Doctor owns the one-time `primary` migration; a runtime fallback would recreate
  // cross-workspace reads. Every operation stays bound to one canonical workspace key.
  const configKey = `onboarding.recommendations.${resolveWorkspaceStateIdentity(params.workspaceDir).workspaceKey}`;
  const database = params.database ?? {};
  return {
    async read() {
      const result = await executeExistingOpenClawStateRead(database, {
        type: "onboardingRecommendations.read",
        configKey,
      });
      if (result === undefined) {
        return null;
      }
      if (result.ok && result.type === "onboardingRecommendations.read") {
        return result.record;
      }
      throw new Error("Unexpected onboarding recommendations read result");
    },
    writeOffer(offer) {
      const captured = prepareOnboardingRecommendationOffer(offer);
      const context = captureOpenClawStateWorkerContext(database);
      return executeOpenClawStateWorker(context, {
        type: "onboardingRecommendations.writeOffer",
        input: { configKey, params: captured },
      });
    },
    acknowledge(options = {}) {
      const context = captureOpenClawStateWorkerContext(database);
      const captured = structuredClone({ ...options, nowMs: options.nowMs ?? Date.now() });
      return executeOpenClawStateWorker(context, {
        type: "onboardingRecommendations.acknowledge",
        input: { configKey, params: captured },
      });
    },
    updatePending(options) {
      const captured = prepareOnboardingRecommendationPending(options);
      const context = captureOpenClawStateWorkerContext(database);
      return executeOpenClawStateWorker(context, {
        type: "onboardingRecommendations.updatePending",
        input: { configKey, params: captured },
      });
    },
    clearPending(options) {
      const context = captureOpenClawStateWorkerContext(database);
      const captured = structuredClone(options);
      return executeOpenClawStateWorker(context, {
        type: "onboardingRecommendations.clearPending",
        input: { configKey, params: captured },
      });
    },
    clear() {
      return executeOpenClawStateWorker(captureOpenClawStateWorkerContext(database), {
        type: "onboardingRecommendations.clear",
        input: { configKey },
      });
    },
  };
}
