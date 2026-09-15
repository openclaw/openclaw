import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { OnboardingRecommendationsRecordSchema } from "./onboarding-recommendations.contract.js";
import {
  createOnboardingRecommendationsStore,
  type OnboardingRecommendationMatch,
} from "./onboarding-recommendations.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";

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

describe("onboarding recommendation record decoding", () => {
  const pending = {
    inventoryHash: "synthetic-inventory",
    matches,
    offeredAt: 0,
    acceptedAt: null,
    updatedAt: 0,
  };

  it.each([
    pending,
    { ...pending, acceptedAt: 1_234, updatedAt: 1_234 },
    { ...pending, matches: [], updatedAt: 2_345 },
    { ...pending, inventoryHash: "", offeredAt: -1, acceptedAt: 0, updatedAt: 0.5 },
  ])("preserves valid pending, accepted, and retry headers: %j", (record) => {
    expect(OnboardingRecommendationsRecordSchema.parse(record)).toEqual(record);
  });

  it("preserves extra record fields while normalizing matches as before", () => {
    const record = {
      ...pending,
      extra: { retained: true },
      matches: [
        {
          ...matches[0]!,
          ignoredMatchField: true,
          candidate: { ...matches[0]!.candidate, ignoredCandidateField: true },
        },
      ],
    };
    expect(OnboardingRecommendationsRecordSchema.parse(record)).toEqual({
      ...pending,
      extra: { retained: true },
    });
    expect(record.matches[0]).toHaveProperty("ignoredMatchField", true);
  });

  it.each([
    { inventoryHash: 123 },
    { offeredAt: "123" },
    { offeredAt: undefined },
    { acceptedAt: "123" },
    { acceptedAt: undefined },
    { updatedAt: null },
    { updatedAt: undefined },
  ])("rejects malformed header fields without opening a database: %j", (header) => {
    expect(OnboardingRecommendationsRecordSchema.safeParse({ ...pending, ...header }).success).toBe(
      false,
    );
  });
});

describe("onboarding recommendations store", () => {
  it("captures the database and offer before asynchronous admission", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-capture" }, async (state) => {
      const originalPath = state.statePath("state", "openclaw.sqlite");
      const replacementPath = state.statePath("replacement.sqlite");
      const database = { env: state.env, path: originalPath };
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database,
      });
      const offer = {
        inventory: [{ label: "Chat" }],
        matches: structuredClone(matches),
        answered: false,
        nowMs: 1_234,
      };
      const writing = store.writeOffer(offer);
      database.path = replacementPath;
      offer.matches[0]!.reason = "Changed after admission";
      offer.nowMs = 5_678;
      const written = await writing;
      expect(written).toMatchObject({ matches, offeredAt: 1_234, updatedAt: 1_234 });
      expect(await store.read()).toBeNull();
      expect(fs.existsSync(replacementPath)).toBe(false);
      await closeOpenClawStateDatabaseAsync();
      const reopened = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database: { env: state.env, path: originalPath },
      });
      expect(await reopened.read()).toEqual(written);
    });
  });

  it("isolates offers by workspace", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-scopes" }, async (state) => {
      const database = { env: state.env };
      const workspaceA = createOnboardingRecommendationsStore({
        workspaceDir: state.path("workspace-a"),
        database,
      });
      const workspaceB = createOnboardingRecommendationsStore({
        workspaceDir: state.path("workspace-b"),
        database,
      });

      const written = await workspaceA.writeOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: false,
        nowMs: 1_234,
      });

      expect(await workspaceB.read()).toBeNull();
      expect(await workspaceB.acknowledge({ nowMs: 2_345 })).toBeNull();
      expect(await workspaceA.read()).toEqual(written);
    });
  });

  it("round-trips the workspace offer and answer timestamps", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations" }, async (state) => {
      const database = { env: state.env };
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database,
      });
      const inventory = [{ label: "Chat", bundleId: "com.example.chat" }];

      expect(await store.read()).toBeNull();
      expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
      const written = await store.writeOffer({
        inventory,
        matches,
        answered: true,
        nowMs: 1_234,
      });

      expect(written).toEqual({
        inventoryHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        matches,
        offeredAt: 1_234,
        acceptedAt: 1_234,
        updatedAt: 1_234,
      });
      expect(await store.read()).toEqual(written);

      const staleCompletion = await store.writeOffer({
        inventory: [{ label: "Different" }],
        matches: [],
        answered: false,
        nowMs: 2_000,
      });
      expect(staleCompletion).toEqual(written);
    });
  });

  it("keeps acceptedAt null when the offer was shown without an answer", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-open" }, async (state) => {
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database: { env: state.env },
      });
      const record = await store.writeOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: false,
        nowMs: 2_345,
      });

      expect(record.acceptedAt).toBeNull();

      const acknowledged = await store.acknowledge({
        nowMs: 3_456,
      });
      expect(acknowledged).toEqual({ ...record, acceptedAt: 3_456, updatedAt: 3_456 });
      expect(await store.read()).toEqual(acknowledged);
    });
  });

  it("updates pending matches without changing the inventory identity", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-retry" }, async (state) => {
      const database = { env: state.env };
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database,
      });
      const record = await store.writeOffer({
        inventory: [{ label: "Chat" }, { label: "Notes" }],
        matches,
        answered: false,
        nowMs: 2_000,
      });
      const retryMatch = { ...matches[0]!, reason: "Retry this install" };

      const updated = await store.updatePending({
        matches: [retryMatch],
        expected: record,
        nowMs: 3_000,
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
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database,
      });
      const original = await store.writeOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: false,
        nowMs: 2_000,
      });
      const replacement = await store.writeOffer({
        inventory: [{ label: "Notes" }],
        matches: [],
        answered: false,
        nowMs: 2_500,
      });

      expect(
        await store.updatePending({
          matches,
          expected: original,
          nowMs: 3_000,
        }),
      ).toBeNull();
      expect(
        await store.acknowledge({
          expected: original,
          nowMs: 3_000,
        }),
      ).toBeNull();
      expect(await store.read()).toEqual(replacement);
    });
  });

  it("clears only pending offers", async () => {
    await withOpenClawTestState(
      { label: "onboarding-recommendations-pending-clear" },
      async (state) => {
        const database = { env: state.env };
        const store = createOnboardingRecommendationsStore({
          workspaceDir: state.workspaceDir,
          database,
        });
        const pending = await store.writeOffer({
          inventory: [{ label: "Chat" }],
          matches,
          answered: false,
        });

        expect(await store.clearPending({ expected: pending })).toBe(true);
        expect(await store.read()).toBeNull();

        const accepted = await store.writeOffer({
          inventory: [{ label: "Chat" }],
          matches,
          answered: true,
        });
        expect(await store.clearPending({ expected: accepted })).toBe(false);
        expect((await store.read())?.acceptedAt).toBeTypeOf("number");
      },
    );
  });

  it("deletes the stored offer so recommendations can be scanned again", async () => {
    await withOpenClawTestState({ label: "onboarding-recommendations-clear" }, async (state) => {
      const database = { env: state.env };
      const store = createOnboardingRecommendationsStore({
        workspaceDir: state.workspaceDir,
        database,
      });
      await store.writeOffer({
        inventory: [{ label: "Chat" }],
        matches,
        answered: true,
        nowMs: 4_567,
      });

      expect(await store.clear()).toBe(true);
      expect(await store.read()).toBeNull();
      expect(await store.clear()).toBe(false);
    });
  });
});
