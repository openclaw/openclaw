import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  acknowledgeOnboardingRecommendations,
  clearPendingOnboardingRecommendations,
  clearOnboardingRecommendations,
  readOnboardingRecommendations,
  updatePendingOnboardingRecommendations,
  writeOnboardingRecommendationsOffer,
  type OnboardingRecommendationMatch,
} from "./onboarding-recommendations.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const matches: OnboardingRecommendationMatch[] = [
  {
    appLabel: "Chat",
    candidateId: "chat-plugin",
    tier: "recommended",
    reason: "Connects conversations",
    candidate: {
      id: "chat-plugin",
      displayName: "Chat plugin",
      summary: "Chat",
      source: "official-channel",
    },
  },
];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("onboarding recommendations store", () => {
  it("round-trips the singleton offer and answer timestamps", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations" }, async (state) => {
      const database = { env: state.env };
      const inventory = [{ label: "Chat", bundleId: "com.example.chat" }];

      expect(readOnboardingRecommendations(database)).toBeNull();
      expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
      const written = writeOnboardingRecommendationsOffer({
        inventory,
        matches,
        answered: true,
        nowMs: 1_234,
        database,
      });

      expect(written).toEqual({
        inventoryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        matches,
        offeredAt: 1_234,
        acceptedAt: 1_234,
        updatedAt: 1_234,
      });
      expect(readOnboardingRecommendations(database)).toEqual(written);

      const staleCompletion = writeOnboardingRecommendationsOffer({
        inventory: [{ label: "Different" }],
        matches: [],
        answered: false,
        nowMs: 2_000,
        database,
      });
      expect(staleCompletion).toEqual(written);
    });
  });

  it("keeps acceptedAt null when the offer was shown without an answer", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-open" }, async (state) => {
      const record = writeOnboardingRecommendationsOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: false,
        nowMs: 2_345,
        database: { env: state.env },
      });

      expect(record.acceptedAt).toBeNull();

      const acknowledged = acknowledgeOnboardingRecommendations({
        nowMs: 3_456,
        database: { env: state.env },
      });
      expect(acknowledged).toEqual({ ...record, acceptedAt: 3_456, updatedAt: 3_456 });
      expect(readOnboardingRecommendations({ env: state.env })).toEqual(acknowledged);
    });
  });

  it("updates pending matches without changing the inventory identity", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-retry" }, async (state) => {
      const database = { env: state.env };
      const record = writeOnboardingRecommendationsOffer({
        inventory: [{ label: "Chat" }, { label: "Notes" }],
        matches,
        answered: false,
        nowMs: 2_000,
        database,
      });
      const retryMatch = { ...matches[0]!, reason: "Retry this install" };

      const updated = updatePendingOnboardingRecommendations({
        matches: [retryMatch],
        expected: record,
        nowMs: 3_000,
        database,
      });

      expect(updated).toEqual({
        ...record,
        matches: [retryMatch],
        updatedAt: 3_000,
      });
      expect(updated?.inventoryHash).toBe(record.inventoryHash);
    });
  });

  it("does not overwrite a concurrently replaced pending offer", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-stale" }, async (state) => {
      const database = { env: state.env };
      const original = writeOnboardingRecommendationsOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: false,
        nowMs: 2_000,
        database,
      });
      const replacement = writeOnboardingRecommendationsOffer({
        inventory: [{ label: "Notes" }],
        matches: [],
        answered: false,
        nowMs: 2_500,
        database,
      });

      expect(
        updatePendingOnboardingRecommendations({
          matches,
          expected: original,
          nowMs: 3_000,
          database,
        }),
      ).toBeNull();
      expect(
        acknowledgeOnboardingRecommendations({
          expected: original,
          nowMs: 3_000,
          database,
        }),
      ).toBeNull();
      expect(readOnboardingRecommendations(database)).toEqual(replacement);
    });
  });

  it("clears only pending offers", async () => {
    await withOpenClawTestState(
      { label: "onboarding-recommendations-pending-clear" },
      async (state) => {
        const database = { env: state.env };
        const pending = writeOnboardingRecommendationsOffer({
          inventory: [{ label: "Chat" }],
          matches,
          answered: false,
          database,
        });

        expect(clearPendingOnboardingRecommendations({ expected: pending, database })).toBe(true);
        expect(readOnboardingRecommendations(database)).toBeNull();

        const accepted = writeOnboardingRecommendationsOffer({
          inventory: [{ label: "Chat" }],
          matches,
          answered: true,
          database,
        });
        expect(clearPendingOnboardingRecommendations({ expected: accepted, database })).toBe(false);
        expect(readOnboardingRecommendations(database)?.acceptedAt).toBeTypeOf("number");
      },
    );
  });

  it("deletes the stored offer so recommendations can be scanned again", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-clear" }, async (state) => {
      const database = { env: state.env };
      writeOnboardingRecommendationsOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: true,
        nowMs: 4_567,
        database,
      });

      expect(clearOnboardingRecommendations(database)).toBe(true);
      expect(readOnboardingRecommendations(database)).toBeNull();
      expect(clearOnboardingRecommendations(database)).toBe(false);
    });
  });
});
