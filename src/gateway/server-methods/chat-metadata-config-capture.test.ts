import { expect, test, vi } from "vitest";
import {
  apiKey,
  authStore,
  harnessRegistry,
  row,
} from "../../agents/model-catalog-fixtures.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as sourceProjection from "../../config/source-value-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

const provider = "fixture";
const runtime = "capture";
const api = "openai-completions";

test("bounds source projection work after neutral reload", async () => {
  const models = Array.from({ length: 32 }, (_, index) =>
    row(provider, `model-${index}`, { api, name: `Model ${index}` }),
  );
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: `${provider}/model-0` },
        models: Object.fromEntries(
          models.map(({ id }) => [`${provider}/${id}`, { agentRuntime: { id: runtime } }]),
        ),
      },
      entries: { main: {} },
    },
    gateway: { port: 18888 },
    models: {
      mode: "replace",
      providers: { [provider]: { api, baseUrl: "https://fixture.invalid/v1", models: [] } },
    },
  };
  // Making an existing resolved default explicit changes source, not runtime policy.
  setRuntimeConfigSnapshot(config, { ...config, gateway: {} });
  const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
  let current = true;
  const owner = Object.assign(createChatMetadataOwner(config, "model-0", {}, provider, api), {
    modelCatalog: { entries: models, routeVariants: models },
    isCurrent: () => current,
    pluginRegistry: harnessRegistry(runtime),
  });
  harness.setOwner(owner);
  harness.setAuthStore(
    authStore({
      [`${provider}:before`]: apiKey(provider, "synthetic"),
      [`${provider}:after`]: apiKey(provider, "synthetic"),
    }),
  );
  const sessionEntry = (profile: string) => ({
    authProfileOverride: `${provider}:${profile}`,
    authProfileOverrideSource: "user" as const,
  });
  const project = vi.spyOn(sourceProjection, "projectRuntimeChangesOntoSource");
  try {
    await harness.runtime.refresh();
    const read = async (profile: string) => {
      project.mockClear();
      const result = await harness.read({ sessionEntry: sessionEntry(profile) });
      expect(result.models?.map(({ id }) => id).toSorted()).toEqual(
        models.map(({ id }) => id).toSorted(),
      );
      return result;
    };
    const before = await read("before");
    const reloaded = structuredClone(config);
    setRuntimeConfigSnapshot(reloaded, reloaded);
    harness.setConfig(reloaded);
    await harness.runtime.refresh();
    const after = await read("after");
    expect(project.mock.calls.length).toBeLessThanOrEqual(1);
    expect(after.models).toEqual(before.models);
    expect(after.accountSelection).toMatchObject({ authProfileId: `${provider}:after` });
    const retained = await read("after");
    expect(project).not.toHaveBeenCalled();
    expect(retained).toEqual(after);
    const readyParams = { readPolicy: "ready" as const, sessionEntry: sessionEntry("after") };
    await harness.read();
    expect(await harness.startup(readyParams)).toBeDefined();
    current = false;
    await expect(harness.startup(readyParams)).resolves.toBeUndefined();
  } finally {
    await harness.runtime.stop();
    project.mockRestore();
    clearRuntimeConfigSnapshot();
  }
});
