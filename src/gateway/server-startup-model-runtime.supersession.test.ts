// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { publishConfiguredModelRuntimeSnapshots } from "./server-startup-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "startup-model-runtime" });
const { mocks } = fixture;

function holdNextStaticCatalogPreparation() {
  const started = createDeferred();
  const release = createDeferred();
  let held = false;
  mocks.prepareStaticCatalog.mockImplementation(async () => {
    if (!held) {
      held = true;
      started.resolve();
      await release.promise;
    }
    return { entries: [] };
  });
  return { started, release };
}

describe("gateway startup model runtime supersession", () => {
  it("defers an in-progress startup publication to a newer publication", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const nextConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const { started, release } = holdNextStaticCatalogPreparation();
    const startup = publishConfiguredModelRuntimeSnapshots({ cfg: config });
    // Surface a startup publication failure before the successor joins.
    void startup.catch(() => undefined);
    let successor: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      await started.promise;
      successor = refreshPreparedModelRuntimeSnapshots(nextConfig);
      release.resolve();
      await expect(startup).resolves.toBeUndefined();
      await successor;
      expect(
        getPreparedModelRuntimeSnapshot(fixture.agentInput("default", nextConfig))?.config,
      ).toBe(nextConfig);
    } finally {
      release.resolve();
      await Promise.allSettled([startup, successor]);
    }
  });
});
