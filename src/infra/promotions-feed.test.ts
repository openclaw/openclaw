// Covers the promotions feed cache: refresh cadence, 304 revalidation,
// sequence monotonicity, notified markers, and claim provenance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  listLivePromotionEntries,
  markPromotionSlugsNotified,
  maybeRefreshPromotionsFeed,
  readPromotionClaims,
  readPromotionsFeedState,
  recordPromotionClaim,
} from "./promotions-feed.js";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");

function feedPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "clawhub-promotions",
    generatedAt: "2026-07-05T00:00:00.000Z",
    sequence: 4,
    expiresAt: "2026-07-06T00:00:00.000Z",
    entries: [
      {
        type: "promotion",
        slug: "example-models-launch",
        title: "Free Example models",
        blurb: "Limited-time offer.",
        startsAt: NOW - 86_400_000,
        endsAt: NOW + 86_400_000,
        provider: "example-provider",
        authChoiceId: "example-provider-api-key",
        models: [{ modelRef: "example-provider/example/model-alpha", alias: "model-alpha" }],
      },
    ],
    ...overrides,
  };
}

function feedResponse(body: unknown, init: { status?: number; etag?: string } = {}) {
  return new Response(init.status === 304 ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.etag ? { etag: init.etag } : {}),
    },
  });
}

describe("promotions feed state", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-promotions-feed-",
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  it("caches a fetched snapshot and round-trips it from storage", async () => {
    const fetchImpl = vi.fn(async () => feedResponse(feedPayload(), { etag: '"v4"' }));
    const state = await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.sequence).toBe(4);
    expect(state.etag).toBe('"v4"');
    expect(state.expiresAtMs).toBe(Date.parse("2026-07-06T00:00:00.000Z"));
    expect(state.entries).toHaveLength(1);

    const persisted = readPromotionsFeedState();
    expect(persisted.sequence).toBe(4);
    expect(persisted.expiresAtMs).toBe(Date.parse("2026-07-06T00:00:00.000Z"));
    expect(persisted.entries[0]?.slug).toBe("example-models-launch");
    expect(listLivePromotionEntries(persisted, NOW)).toHaveLength(1);
    expect(listLivePromotionEntries(persisted, NOW + 3 * 86_400_000)).toHaveLength(0);
  });

  it("skips the network while the last check is fresh", async () => {
    const fetchImpl = vi.fn(async () => feedResponse(feedPayload()));
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl });
    const second = await maybeRefreshPromotionsFeed({ nowMs: NOW + 60_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.entries).toHaveLength(1);
  });

  it("refreshes at feed expiry and keeps an expired 304 snapshot hidden without retrying", async () => {
    const expiresAt = new Date(NOW + 60_000).toISOString();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse(feedPayload({ expiresAt }), { etag: '"v4"' }))
      .mockResolvedValueOnce(feedResponse(null, { status: 304 }));
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl });

    const expired = await maybeRefreshPromotionsFeed({ nowMs: NOW + 60_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(listLivePromotionEntries(expired, NOW + 60_000)).toHaveLength(0);

    const cached = await maybeRefreshPromotionsFeed({ nowMs: NOW + 61_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(listLivePromotionEntries(cached, NOW + 61_000)).toHaveLength(0);
  });

  it("keeps an expired snapshot hidden after a failed expiry refresh without retrying", async () => {
    const expiresAt = new Date(NOW + 60_000).toISOString();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse(feedPayload({ expiresAt })))
      .mockRejectedValueOnce(new Error("offline"));
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl });

    const expired = await maybeRefreshPromotionsFeed({ nowMs: NOW + 60_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(listLivePromotionEntries(expired, NOW + 60_000)).toHaveLength(0);

    const cached = await maybeRefreshPromotionsFeed({ nowMs: NOW + 61_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(listLivePromotionEntries(cached, NOW + 61_000)).toHaveLength(0);
  });

  it("replaces an expired snapshot when ClawHub publishes a newer sequence", async () => {
    const firstExpiry = new Date(NOW + 60_000).toISOString();
    const nextExpiry = new Date(NOW + 86_400_000).toISOString();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse(feedPayload({ expiresAt: firstExpiry, sequence: 4 })))
      .mockResolvedValueOnce(feedResponse(feedPayload({ expiresAt: nextExpiry, sequence: 5 })));
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl });

    const refreshed = await maybeRefreshPromotionsFeed({ nowMs: NOW + 60_000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(refreshed.sequence).toBe(5);
    expect(refreshed.expiresAtMs).toBe(Date.parse(nextExpiry));
    expect(listLivePromotionEntries(refreshed, NOW + 60_000)).toHaveLength(1);
  });

  it("revalidates with If-None-Match and keeps the cache on 304", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse(feedPayload(), { etag: '"v4"' }))
      .mockResolvedValueOnce(feedResponse(null, { status: 304 }));
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl });
    const state = await maybeRefreshPromotionsFeed({ nowMs: NOW + 60_000, force: true, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(secondInit.headers).get("if-none-match")).toBe('"v4"');
    expect(state.entries).toHaveLength(1);
    expect(readPromotionsFeedState().lastCheckedAtMs).toBe(NOW + 60_000);
  });

  it("drops a stale validator when the cached payload is invalid", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse(feedPayload(), { etag: '"v4"' }))
      .mockResolvedValueOnce(feedResponse(feedPayload({ sequence: 5 }), { etag: '"v5"' }));
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl });
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely =
        getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "clawhub_promotions_feed_state">>(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("clawhub_promotions_feed_state")
          .set({ payload_json: "{invalid" })
          .where("state_key", "=", "default"),
      );
    });

    const state = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 60_000,
      fetchImpl,
    });

    const secondInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(secondInit.headers).get("if-none-match")).toBeNull();
    expect(state.sequence).toBe(5);
    expect(state.etag).toBe('"v5"');
    expect(state.entries).toHaveLength(1);
  });

  it("never replaces the cache with an older snapshot sequence", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse(feedPayload({ sequence: 4 })))
      .mockResolvedValueOnce(feedResponse(feedPayload({ sequence: 2, entries: [] })));
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl });
    const state = await maybeRefreshPromotionsFeed({ nowMs: NOW + 60_000, force: true, fetchImpl });
    expect(state.sequence).toBe(4);
    expect(state.entries).toHaveLength(1);
  });

  it("fails silent on network errors and keeps the cached snapshot", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(feedResponse(feedPayload()))
      .mockRejectedValueOnce(new Error("offline"));
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl });
    const state = await maybeRefreshPromotionsFeed({ nowMs: NOW + 60_000, force: true, fetchImpl });
    expect(state.entries).toHaveLength(1);
    // The failed attempt still stamps the check time so offline runs do not
    // retry on every command.
    expect(state.lastCheckedAtMs).toBe(NOW + 60_000);
  });

  it("persists notified slugs across reads", () => {
    markPromotionSlugsNotified(["example-models-launch", "second-offer"]);
    markPromotionSlugsNotified(["example-models-launch"]);
    expect([...readPromotionsFeedState().notifiedSlugs].toSorted()).toEqual([
      "example-models-launch",
      "second-offer",
    ]);
  });

  it("round-trips claim provenance and upserts by slug", () => {
    recordPromotionClaim({
      slug: "example-models-launch",
      provider: "example-provider",
      modelKeys: ["example-provider/example/model-alpha"],
      endsAtMs: NOW + 86_400_000,
      claimedAtMs: NOW,
    });
    recordPromotionClaim({
      slug: "example-models-launch",
      provider: "example-provider",
      modelKeys: ["example-provider/example/model-alpha", "example-provider/example/model-beta"],
      endsAtMs: NOW + 2 * 86_400_000,
      claimedAtMs: NOW + 1,
    });
    const claims = readPromotionClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.modelKeys).toHaveLength(2);
    expect(claims[0]?.endsAtMs).toBe(NOW + 2 * 86_400_000);
  });
});
