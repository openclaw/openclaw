import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import {
  readConfigMachineState,
  readConfigMachineStateWithMetadata,
} from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { markPromotionSlugsNotified, recordPromotionClaim } from "./promotions-feed.js";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
describe("explicit promotion provenance", () => {
  let testState: OpenClawTestState;
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-promotions-feed-",
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    await testState.cleanup();
  });
  it("keeps worker failures best-effort without synchronous fallback", async () => {
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockRejectedValueOnce(
      new Error("Synthetic worker refusal"),
    );
    vi.spyOn(stateWorker, "executeOpenClawStateWorker").mockRejectedValueOnce(
      new Error("Synthetic worker refusal"),
    );
    const mainSql = observeMainThreadSql();
    try {
      await expect(markPromotionSlugsNotified(["example-offer"])).resolves.toBeUndefined();
      await expect(
        recordPromotionClaim({
          slug: "example-offer",
          modelKeys: [],
          endsAtMs: NOW,
          claimedAtMs: NOW,
        }),
      ).resolves.toBeUndefined();
      mainSql.expectIdle();
      expect(existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
    } finally {
      mainSql.restore();
    }
  });
  it("unions concurrent notices off-thread while preserving stored feed fields", async () => {
    updateConfigMachineState("clawhub.promotionsFeed", () => ({
      etag: "retained",
      payloadJson: "retained-payload",
      sequence: 4,
      lastCheckedAtMs: NOW,
      notifiedSlugs: [],
    }));
    await closeOpenClawStateDatabaseAsync();
    const mainSql = observeMainThreadSql();
    try {
      await Promise.all([
        markPromotionSlugsNotified(["second-offer", "example-models-launch"]),
        markPromotionSlugsNotified(["example-models-launch", "third-offer"]),
      ]);
      mainSql.expectIdle();
    } finally {
      mainSql.restore();
    }
    await closeOpenClawStateDatabaseAsync();
    expect(readConfigMachineState("clawhub.promotionsFeed")).toEqual({
      etag: "retained",
      payloadJson: "retained-payload",
      sequence: 4,
      lastCheckedAtMs: NOW,
      notifiedSlugs: ["example-models-launch", "second-offer", "third-offer"],
    });
  });
  it("leaves absent state absent for empty notices and existing notices unchanged", async () => {
    const databasePath = resolveOpenClawStateSqlitePath();
    await markPromotionSlugsNotified([]);
    expect(existsSync(databasePath)).toBe(false);
    await markPromotionSlugsNotified(["known-offer"]);
    await closeOpenClawStateDatabaseAsync();
    const before = readConfigMachineStateWithMetadata("clawhub.promotionsFeed");
    const bytes = await readFile(databasePath);
    const mainSql = observeMainThreadSql();
    try {
      await markPromotionSlugsNotified(new Set(["known-offer"]));
      mainSql.expectIdle();
    } finally {
      mainSql.restore();
    }
    await closeOpenClawStateDatabaseAsync();
    expect(await readFile(databasePath)).toEqual(bytes);
    expect(readConfigMachineStateWithMetadata("clawhub.promotionsFeed")).toEqual(before);
  });
  it("captures notice inputs, timestamp, and state path before waiting", async () => {
    const databasePath = resolveOpenClawStateSqlitePath();
    const slugs = new Set(["original-offer"]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const pending = markPromotionSlugsNotified(slugs);
    slugs.clear();
    slugs.add("later-offer");
    clock.mockReturnValue(NOW + 1);
    process.env.OPENCLAW_STATE_DIR = testState.statePath("later-state");
    try {
      await pending;
      expect(existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
    } finally {
      process.env.OPENCLAW_STATE_DIR = testState.stateDir;
      clock.mockRestore();
    }
    expect(
      readConfigMachineStateWithMetadata("clawhub.promotionsFeed", { path: databasePath }),
    ).toMatchObject({ value: { notifiedSlugs: ["original-offer"] }, updatedAtMs: NOW });
  });
  it("captures claim inputs and upserts durably off-thread", async () => {
    const original = {
      slug: "captured-models-launch",
      provider: "example-provider",
      modelKeys: ["example-provider/example/model-alpha"],
      endsAtMs: NOW + 86_400_000,
      claimedAtMs: NOW,
    };
    const mainSql = observeMainThreadSql();
    try {
      const pending = recordPromotionClaim(original);
      original.modelKeys.push("example-provider/later-mutation");
      original.slug = "later-slug";
      await pending;
      await recordPromotionClaim({
        slug: "example-models-launch",
        provider: "example-provider",
        modelKeys: ["example-provider/example/model-alpha"],
        endsAtMs: NOW,
        claimedAtMs: NOW,
      });
      await recordPromotionClaim({
        slug: "example-models-launch",
        modelKeys: ["example-provider/example/model-beta"],
        endsAtMs: NOW + 2 * 86_400_000,
        claimedAtMs: NOW + 1,
      });
      mainSql.expectIdle();
    } finally {
      mainSql.restore();
    }
    await closeOpenClawStateDatabaseAsync();
    const database = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<Pick<DB, "clawhub_promotion_claims">>(database.db);
    const { rows: claims } = executeSqliteQuerySync(
      database.db,
      db.selectFrom("clawhub_promotion_claims").selectAll().orderBy("slug"),
    );
    expect(claims).toEqual([
      {
        slug: "captured-models-launch",
        provider: "example-provider",
        model_keys_json: JSON.stringify(["example-provider/example/model-alpha"]),
        ends_at_ms: NOW + 86_400_000,
        claimed_at_ms: NOW,
      },
      {
        slug: "example-models-launch",
        provider: null,
        model_keys_json: JSON.stringify(["example-provider/example/model-beta"]),
        ends_at_ms: NOW + 2 * 86_400_000,
        claimed_at_ms: NOW + 1,
      },
    ]);
  });
});
