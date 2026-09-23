import { z } from "zod";
import { sha256Hex } from "../infra/crypto-digest.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";

const OnboardingRecommendationMatchSchema = z.object({
  appLabel: z.string(),
  candidateId: z.string(),
  tier: z.enum(["recommended", "optional"]),
  reason: z.string(),
  candidate: z.object({
    id: z.string(),
    displayName: z.string(),
    summary: z.string(),
    source: z.enum(["official-plugin", "official-channel", "official-provider", "clawhub-skill"]),
    downloads: z.number().optional(),
  }),
});

export const OnboardingRecommendationMatchesSchema = z.array(OnboardingRecommendationMatchSchema);

export type OnboardingRecommendationMatch = z.infer<typeof OnboardingRecommendationMatchSchema>;

export type OnboardingRecommendationsRecord = {
  inventoryHash: string;
  matches: OnboardingRecommendationMatch[];
  offeredAt: number;
  acceptedAt: number | null;
  updatedAt: number;
};

type OnboardingRecommendationInventoryItem = {
  label: string;
  bundleId?: string;
};

export type WriteOnboardingRecommendationsOfferParams = {
  inventory: readonly OnboardingRecommendationInventoryItem[];
  matches: readonly OnboardingRecommendationMatch[];
  answered: boolean;
  nowMs?: number;
};

export type AcknowledgeOnboardingRecommendationsParams = {
  nowMs?: number;
  expected?: OnboardingRecommendationsRecord;
};

export type UpdatePendingOnboardingRecommendationsParams = {
  matches: readonly OnboardingRecommendationMatch[];
  expected: OnboardingRecommendationsRecord;
  nowMs?: number;
};

export type ClearPendingOnboardingRecommendationsParams = {
  expected: OnboardingRecommendationsRecord;
};

export type PreparedOnboardingRecommendationOffer = {
  inventoryHash: string;
  matches: OnboardingRecommendationMatch[];
  answered: boolean;
  nowMs: number;
};

export type PreparedOnboardingRecommendationPending = {
  matches: OnboardingRecommendationMatch[];
  expected: OnboardingRecommendationsRecord;
  nowMs: number;
};

function canonicalInventory(
  inventory: readonly OnboardingRecommendationInventoryItem[],
): OnboardingRecommendationInventoryItem[] {
  return inventory
    .map((app) => ({
      label: app.label,
      ...(app.bundleId ? { bundleId: app.bundleId } : {}),
    }))
    .toSorted(
      (left, right) =>
        left.label.localeCompare(right.label, "en", { sensitivity: "base" }) ||
        (left.bundleId ?? "").localeCompare(right.bundleId ?? ""),
    );
}

function hashOnboardingRecommendationInventory(
  inventory: readonly OnboardingRecommendationInventoryItem[],
): string {
  return sha256Hex(JSON.stringify(canonicalInventory(inventory)));
}

export function prepareOnboardingRecommendationOffer(
  params: WriteOnboardingRecommendationsOfferParams,
): PreparedOnboardingRecommendationOffer {
  const nowMs = params.nowMs ?? Date.now();
  const inventoryHash = hashOnboardingRecommendationInventory(params.inventory);
  const matches = OnboardingRecommendationMatchesSchema.parse(params.matches);
  return { inventoryHash, matches, answered: params.answered, nowMs };
}

export function prepareOnboardingRecommendationPending(
  params: UpdatePendingOnboardingRecommendationsParams,
): PreparedOnboardingRecommendationPending {
  const nowMs = params.nowMs ?? Date.now();
  const matches = OnboardingRecommendationMatchesSchema.parse(params.matches);
  return { matches, expected: structuredClone(params.expected), nowMs };
}

export type OnboardingRecommendationWriteOperations = {
  "onboardingRecommendations.writeOffer": {
    input: { configKey: string; params: PreparedOnboardingRecommendationOffer };
    output: OnboardingRecommendationsRecord;
  };
  "onboardingRecommendations.acknowledge": {
    input: { configKey: string; params: AcknowledgeOnboardingRecommendationsParams };
    output: OnboardingRecommendationsRecord | null;
  };
  "onboardingRecommendations.updatePending": {
    input: { configKey: string; params: PreparedOnboardingRecommendationPending };
    output: OnboardingRecommendationsRecord | null;
  };
  "onboardingRecommendations.clearPending": {
    input: { configKey: string; params: ClearPendingOnboardingRecommendationsParams };
    output: boolean;
  };
  "onboardingRecommendations.clear": {
    input: { configKey: string };
    output: boolean;
  };
};

export function isOnboardingRecommendationWriteCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<OnboardingRecommendationWriteOperations> {
  switch (command.type) {
    case "onboardingRecommendations.writeOffer":
    case "onboardingRecommendations.acknowledge":
    case "onboardingRecommendations.updatePending":
    case "onboardingRecommendations.clearPending":
    case "onboardingRecommendations.clear":
      return true;
    default:
      return false;
  }
}
