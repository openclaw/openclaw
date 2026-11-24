import { describe, expect, it } from "vitest";
import { PROVIDER_ID } from "../../agents/prepared-model-catalog-worker.test-support.js";
import { createStaticCatalogSnapshotFixture } from "../../agents/test-helpers/prepared-model-catalog-static-fixture.js";
import {
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "../../agents/test-helpers/prepared-model-catalog-worker-fixture.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s prepared catalog worker",
  (engine) => {
    useMixedAgentPair(engine, engine);
    const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();
    const createSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });

    it("reads persisted plugin catalogs inside the full-inventory worker", async () => {
      const fixture = await createSnapshot(0, {
        CODEX_HOME: makeTempDir("catalog-conformance-codex-"),
      });
      const catalog = await loadCompletedFullCatalog(fixture.snapshot);
      expect(catalog.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
      );
    });
  },
);
