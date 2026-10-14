import { afterEach, expect, it, vi } from "vitest";
import * as catalogWorker from "../../src/agents/prepared-model-catalog-worker.js";
import { PROVIDER_ID } from "../../src/agents/prepared-model-catalog-worker.test-support.js";
import { createStaticCatalogSnapshotFixture } from "../../src/agents/test-helpers/prepared-model-catalog-static-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "../../src/agents/test-helpers/prepared-model-catalog-worker-fixture.js";
import * as codexClientVersion from "../../src/plugin-sdk/codex-client-version-runtime.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();
const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });

afterEach(() => vi.restoreAllMocks());

it("hands catalog workers the parent's changed Codex version", async () => {
  const resolveVersion = vi
    .spyOn(codexClientVersion, "resolveCodexClientVersion")
    .mockResolvedValue("0.162.1");
  const fixture = await createStaticSnapshot(0, {}, { reportCodexClientVersion: true });
  const reportedByWorker = async () =>
    (await fixture.snapshot.loadFullModelCatalog!({ refresh: true, wait: true })).entries
      .filter((entry) => entry.provider === PROVIDER_ID && entry.id.startsWith("codex-client-"))
      .map((entry) => entry.id);

  expect(await reportedByWorker()).toEqual(["codex-client-0.162.1"]);

  // The parent changed to its bundled fallback; workers consume that decision.
  resolveVersion.mockResolvedValue("0.160.0");
  expect(await reportedByWorker()).toEqual(["codex-client-0.160.0"]);
});

it("does not select Codex for unrelated catalogs or auth-only refreshes", async () => {
  let checkScope: (() => Promise<void>) | undefined;
  const createWorker = catalogWorker.createPreparedModelCatalogWorker;
  const tracking = vi
    .spyOn(catalogWorker, "createPreparedModelCatalogWorker")
    .mockImplementation((params) => {
      const worker = createWorker(params);
      checkScope = async () => {
        const catalog = await worker.loadCatalog([PROVIDER_ID], undefined, true);
        expect(catalog.modelCatalog.entries).toContainEqual(
          expect.objectContaining({ provider: PROVIDER_ID, id: "sqlite-model" }),
        );
        await worker.loadAuth({ providerIds: [PROVIDER_ID], profileIds: [] });
      };
      return worker;
    });
  const resolveVersion = vi.spyOn(codexClientVersion, "resolveCodexClientVersion");
  try {
    await createStaticSnapshot(0);
    expect(checkScope).toBeDefined();
    resolveVersion.mockClear();
    await checkScope!();
    expect(resolveVersion).not.toHaveBeenCalled();
  } finally {
    resolveVersion.mockRestore();
    tracking.mockRestore();
  }
});
