import { z } from "zod";
import { sha256Hex } from "../infra/crypto-digest.js";

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

export type PreparedOnboardingRecommendationOffer = ReturnType<
  typeof prepareOnboardingRecommendationOffer
>;
export type PreparedOnboardingRecommendationPending = ReturnType<
  typeof prepareOnboardingRecommendationPending
>;

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

export function prepareOnboardingRecommendationOffer(
  params: WriteOnboardingRecommendationsOfferParams,
) {
  const nowMs = params.nowMs ?? Date.now();
  const inventoryHash = sha256Hex(JSON.stringify(canonicalInventory(params.inventory)));
  const matches = OnboardingRecommendationMatchesSchema.parse(params.matches);
  return { inventoryHash, matches, answered: params.answered, nowMs };
}

export function prepareOnboardingRecommendationPending(
  params: UpdatePendingOnboardingRecommendationsParams,
) {
  const nowMs = params.nowMs ?? Date.now();
  const matches = OnboardingRecommendationMatchesSchema.parse(params.matches);
  return { matches, expected: structuredClone(params.expected), nowMs };
}
