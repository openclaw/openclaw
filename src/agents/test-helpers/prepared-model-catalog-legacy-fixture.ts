import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnv } from "../../test-utils/env.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { apiKey, authStore, model } from "../model-catalog-fixtures.test-support.js";
import type { ModelCatalogSnapshot } from "../model-catalog.types.js";
import {
  CATALOG_ALIAS_ID,
  EXTERNAL_AUTH_PATH_ENV,
  PROVIDER_ID,
  catalogInput,
  createCatalogFixture,
  startCatalogBuild,
} from "../prepared-model-catalog-worker.test-support.js";
import { retainPreparedPluginGeneration } from "../prepared-model-runtime.plugin-lifetime.js";

export async function expectLegacyWorkerCatalogRetention(params: {
  makeTempDir: (prefix: string) => string;
  retireAfterTest: (retire: () => void) => void;
  catalogReturnsRows: boolean;
  aliasOnly?: boolean;
}): Promise<void> {
  const fixture = await createCatalogFixture(
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
      authStore({ [`${PROVIDER_ID}:legacy`]: apiKey(PROVIDER_ID, "legacy-worker-key-not-real") }),
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
          models: [model("configured-row", "Configured-only model", { contextWindow: 8192 })],
        },
      },
    },
  };
  const input = catalogInput({ ...fixture, config });
  const retirement = new AbortController();
  params.retireAfterTest(() => retirement.abort());
  const build = (
    await startCatalogBuild(input, retirement, { provenance: "standalone" }).pending
  )[0]!;
  await using _ = {
    [Symbol.asyncDispose]: retainPreparedPluginGeneration(build.pluginGeneration),
  };
  const snapshot = build.snapshot;
  const refresh = (mode?: string) => {
    if (mode) {
      fs.writeFileSync(control, mode, "utf8");
    }
    return snapshot.loadFullModelCatalog!({ refresh: true });
  };
  const learnedIds = (catalog: ModelCatalogSnapshot) =>
    catalog.entries
      .filter(
        ({ provider, id }) => provider === PROVIDER_ID && (id === "Learned" || id === "learned"),
      )
      .map(({ id }) => id)
      .toSorted();
  const entry = (catalog: ModelCatalogSnapshot, id: string) =>
    catalog.entries.find((row) => row.provider === PROVIDER_ID && row.id === id);
  const expectConfiguredRow = (catalog: ModelCatalogSnapshot, revision: number) => {
    expect(catalog.entries.filter(({ id }) => id.startsWith("proof-refresh-"))).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(new RegExp(`^proof-refresh-${revision}-`)),
      }),
    ]);
    expect(entry(catalog, "configured-row")?.statusReason).toBe(`refresh-${revision}`);
  };
  const initial = await refresh();
  expect(learnedIds(initial)).toEqual(params.catalogReturnsRows ? ["Learned", "learned"] : []);
  const failed = await refresh("unavailable");
  expect(failed.providerOutcomes).toContainEqual({ provider: PROVIDER_ID, status: "unavailable" });
  // Failed discovery keeps the entire last-good provider snapshot, including overlays.
  expectConfiguredRow(failed, 1);
  if (params.catalogReturnsRows) {
    expect(learnedIds(failed)).toEqual(["Learned", "learned"]);
    const repeated = await refresh();
    expect(learnedIds(repeated)).toEqual(["Learned", "learned"]);
    expectConfiguredRow(repeated, 1);
    const seeded = await refresh("seed");
    expect(entry(seeded, "Learned")?.name).toBe("Uppercase legacy model");
    expectConfiguredRow(seeded, 1);
    const empty = await refresh("empty");
    expect(learnedIds(empty)).toEqual([]);
    const afterEmpty = await refresh("unavailable");
    expect(learnedIds(afterEmpty)).toEqual([]);
    expectConfiguredRow(afterEmpty, 5);
  }
}
