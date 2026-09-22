import { onTestFinished, vi } from "vitest";
import type { createModelRuntimeChoiceOwnerFixture } from "../../agents/model-runtime-choice.test-support.js";
import type { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";

type ModelRuntimeFixtureArgs = Parameters<typeof createModelRuntimeChoiceOwnerFixture>;

export async function mockPublishedModelRuntimeForTest(params: {
  config: ModelRuntimeFixtureArgs[0];
  isCurrent?: ModelRuntimeFixtureArgs[1];
  facts?: ModelRuntimeFixtureArgs[2];
  paths?: ModelRuntimeFixtureArgs[3];
  authStore?: Parameters<typeof setPreparedModelRuntimeAuthStore>[1];
}): Promise<void> {
  const [fixture, auth, publishedCatalog] = await Promise.all([
    import("../../agents/model-runtime-choice.test-support.js"),
    import("../../agents/prepared-model-runtime-auth.js"),
    import("../../agents/prepared-model-catalog.js"),
  ]);
  const owner = fixture.createModelRuntimeChoiceOwnerFixture(
    params.config,
    params.isCurrent,
    params.facts,
    params.paths,
  );
  if (params.authStore) {
    auth.setPreparedModelRuntimeAuthStore(owner, params.authStore);
  }
  const lookup = vi
    .spyOn(publishedCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot")
    .mockReturnValue(owner);
  onTestFinished(() => lookup.mockRestore());
}
