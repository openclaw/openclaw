import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });
  it("deduplicates notified slugs while preserving stored feed fields", () => {
    updateConfigMachineState("clawhub.promotionsFeed", () => ({
      etag: "retained",
      payloadJson: "retained-payload",
      sequence: 4,
      lastCheckedAtMs: NOW,
      notifiedSlugs: [],
    }));
    markPromotionSlugsNotified(["example-models-launch", "second-offer"]);
    markPromotionSlugsNotified(["example-models-launch"]);
    expect(readConfigMachineState("clawhub.promotionsFeed")).toEqual({
      etag: "retained",
      payloadJson: "retained-payload",
      sequence: 4,
      lastCheckedAtMs: NOW,
      notifiedSlugs: ["example-models-launch", "second-offer"],
    });
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
    const database = openOpenClawStateDatabase();
    const db = getNodeSqliteKysely<Pick<DB, "clawhub_promotion_claims">>(database.db);
    const { rows: claims } = executeSqliteQuerySync(
      database.db,
      db.selectFrom("clawhub_promotion_claims").selectAll(),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.model_keys_json).toBe(
      JSON.stringify([
        "example-provider/example/model-alpha",
        "example-provider/example/model-beta",
      ]),
    );
    expect(claims[0]?.ends_at_ms).toBe(NOW + 2 * 86_400_000);
  });
});
