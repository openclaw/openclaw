import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnv } from "../../test-utils/env.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import type { ModelCatalogSnapshot } from "../model-catalog.types.js";
import { preparePublishedModelCatalogOwnerIdentity } from "../prepared-model-catalog-owner.js";
import {
  CATALOG_ALIAS_ID,
  EXTERNAL_AUTH_PATH_ENV,
  PROVIDER_ID,
  createCatalogFixture,
} from "../prepared-model-catalog-worker.test-support.js";
import { startSerializedSnapshotBuildBatch } from "../prepared-model-runtime.build.js";
import { retainPreparedPluginGeneration } from "../prepared-model-runtime.plugin-lifetime.js";

export async function expectLegacyWorkerCatalogRetention(params: {
  makeTempDir: (prefix: string) => string;
  retireAfterTest: (retire: () => void) => void;
  catalogReturnsRows: boolean;
  aliasOnly?: boolean;
}): Promise<void> {
  const fixture = createCatalogFixture(
    params.makeTempDir,
    0,
    { [EXTERNAL_AUTH_PATH_ENV]: "" },
    { catalogControl: true },
  );
  const control = path.join(fixture.root, "catalog-control.txt");
  if (params.aliasOnly) {
    fs.writeFileSync(control, "alias", "utf8");
    fixture.config.agents.defaults.model = `${CATALOG_ALIAS_ID}/sqlite-model`;
  } else if (!params.catalogReturnsRows) {
    fs.writeFileSync(control, "configured", "utf8");
  }
  withEnv(fixture.env, () =>
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [`${PROVIDER_ID}:legacy`]: {
            type: "api_key",
            provider: PROVIDER_ID,
            key: "legacy-worker-key-not-real",
          },
        },
      },
      fixture.agentDir,
    ),
  );
  const config: OpenClawConfig = {
    ...fixture.config,
    models: {
      providers: {
        [PROVIDER_ID]: {
          baseUrl: "https://worker-catalog.invalid/v1",
          api: "openai-completions",
          models: [
            {
              id: "configured-row",
              name: "Configured-only model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
  };
  const input = {
    agentId: "main",
    agentDir: fixture.agentDir,
    inheritedAuthDir: fixture.agentDir,
    workspaceDir: fixture.workspaceDir,
    config,
    env: fixture.env,
  };
  const retirement = new AbortController();
  const isCurrent = () => !retirement.signal.aborted;
  params.retireAfterTest(() => retirement.abort());
  const build = (
    await startSerializedSnapshotBuildBatch(
      [
        {
          input,
          catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
          inventoryOwner: { provenance: "standalone" },
          isGenerationCurrent: isCurrent,
          retirementSignal: retirement.signal,
          isBuildCurrent: isCurrent,
        },
      ],
      new Map(),
      30_000,
      "static",
    ).pending
  )[0]!;
  await using _ = {
    [Symbol.asyncDispose]: retainPreparedPluginGeneration(build.pluginGeneration),
  };
  const snapshot = build.snapshot;
  const learnedIds = (catalog: ModelCatalogSnapshot) =>
    catalog.entries
      .filter(
        ({ provider, id }) => provider === PROVIDER_ID && (id === "Learned" || id === "learned"),
      )
      .map(({ id }) => id)
      .toSorted();
  const expectFreshConfiguredRow = (catalog: ModelCatalogSnapshot, revision: number) => {
    expect(catalog.entries.filter(({ id }) => id.startsWith("proof-refresh-"))).toEqual([]);
    expect(
      catalog.entries.find(
        ({ provider, id }) => provider === PROVIDER_ID && id === "configured-row",
      )?.statusReason,
    ).toBe(`refresh-${revision}`);
  };
  const initial = await snapshot.loadFullModelCatalog!({ refresh: true });
  expect(learnedIds(initial)).toEqual(params.catalogReturnsRows ? ["Learned", "learned"] : []);
  fs.writeFileSync(control, "unavailable", "utf8");
  const failed = await snapshot.loadFullModelCatalog!({ refresh: true });
  expect(failed.providerOutcomes).toContainEqual({ provider: PROVIDER_ID, status: "unavailable" });
  expectFreshConfiguredRow(failed, 2);
  if (params.catalogReturnsRows) {
    expect(learnedIds(failed)).toEqual(["Learned", "learned"]);
    const repeated = await snapshot.loadFullModelCatalog!({ refresh: true });
    expect(learnedIds(repeated)).toEqual(["Learned", "learned"]);
    expectFreshConfiguredRow(repeated, 3);
    fs.writeFileSync(control, "seed", "utf8");
    const seeded = await snapshot.loadFullModelCatalog!({ refresh: true });
    expect(
      seeded.entries.find(({ provider, id }) => provider === PROVIDER_ID && id === "Learned")?.name,
    ).toBe("Uppercase legacy model");
    expectFreshConfiguredRow(seeded, 4);
    fs.writeFileSync(control, "empty", "utf8");
    const empty = await snapshot.loadFullModelCatalog!({ refresh: true });
    expect(learnedIds(empty)).toEqual([]);
    fs.writeFileSync(control, "unavailable", "utf8");
    const afterEmpty = await snapshot.loadFullModelCatalog!({ refresh: true });
    expect(learnedIds(afterEmpty)).toEqual([]);
    expectFreshConfiguredRow(afterEmpty, 6);
  }
}
