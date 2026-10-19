import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import {
  deleteConfigMachineState,
  importConfigMachineState,
  writeConfigMachineState,
} from "../state/config-machine-state-write.js";
import {
  readConfigMachineState,
  readConfigMachineStateRowInDatabase,
} from "../state/config-machine-state.js";
import { recordOpenClawStateDatabaseOpenFailure } from "../state/openclaw-state-db-cache.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import {
  markRemoteModelCatalogCheckedAsync,
  readRemoteModelCatalog,
  readRemoteModelCatalogAsync,
  writeRemoteModelCatalogAsync,
} from "./remote-store.js";

// Registered first so it removes directories after the database closes below.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeStateDatabaseForTest);
afterEach(() => vi.restoreAllMocks());

describe("remote model catalog store", () => {
  it("reuses published catalog rows across unrelated writes and follows committed replacements", async () => {
    const options = { path: path.join(tempDirs.make("openclaw-catalog-receipt-"), "state.sqlite") };
    const other = { path: path.join(tempDirs.make("openclaw-catalog-other-"), "state.sqlite") };
    writeConfigMachineState("fixture.unrelated", true, options);
    writeConfigMachineState("fixture.unrelated", true, other);
    const operations = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
    const read = () => readRemoteModelCatalogAsync(captureOpenClawStateWorkerContext(options));
    expect(await read()).toBeUndefined();
    operations.mockClear();
    expect(
      await readRemoteModelCatalogAsync(captureOpenClawStateWorkerContext(other)),
    ).toBeUndefined();
    expect(operations).toHaveBeenCalledOnce();
    operations.mockClear();
    writeConfigMachineState("fixture.unrelated", false, options);
    expect(await read()).toBeUndefined();
    expect(operations).not.toHaveBeenCalled();

    const initial = {
      bundle_json: '{"schemaVersion":1}',
      generated_at: 1,
      min_version: null,
      source_url: "https://catalog.test/receipt",
      etag: null,
      last_modified: null,
      checked_at: 2,
    };
    await writeRemoteModelCatalogAsync(initial, captureOpenClawStateWorkerContext(options));
    expect(await read()).toEqual({ id: 1, ...initial });
    operations.mockClear();
    const retained = await read();
    retained!.checked_at = -1;
    expect(await read()).toEqual({ id: 1, ...initial });
    expect(operations).not.toHaveBeenCalled();

    const selectedContext = withDatabaseEngineSelection(
      { effectiveEngines: resolveDatabaseFamilyEngines({}) },
      () => captureOpenClawStateWorkerContext(options),
    );
    expect(await readRemoteModelCatalogAsync(selectedContext)).toEqual({ id: 1, ...initial });
    expect(operations).toHaveBeenCalledOnce();
    operations.mockClear();
    expect(await read()).toEqual({ id: 1, ...initial });
    expect(await readRemoteModelCatalogAsync(selectedContext)).toEqual({ id: 1, ...initial });
    expect(operations).not.toHaveBeenCalled();

    await withArtifactPreservingStateReads(read);
    const inspection = withArtifactPreservingStateReads(
      () => captureOpenClawStateWorkerContext(options),
      { agentDatabases: true },
    );
    await readRemoteModelCatalogAsync(inspection);
    expect(operations).toHaveBeenCalledTimes(2);

    await markRemoteModelCatalogCheckedAsync(
      3,
      { expected: initial },
      captureOpenClawStateWorkerContext(options),
    );
    expect(await read()).toEqual({ id: 1, ...initial, checked_at: 3 });
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        writeConfigMachineState("modelCatalog.remote.v3", { ...initial, checked_at: 4 }, options);
        throw new Error("rollback catalog");
      }, options),
    ).toThrow("rollback catalog");
    expect(await read()).toEqual({ id: 1, ...initial, checked_at: 3 });
    deleteConfigMachineState("modelCatalog.remote.v3", options);
    expect(await read()).toBeUndefined();
    importConfigMachineState([["modelCatalog.remote.v2", initial]], options);
    expect(await read()).toEqual({ id: 1, ...initial });
    writeConfigMachineState("modelCatalog.remote.v2", null, options);
    writeConfigMachineState("modelCatalog.remote", { ...initial, checked_at: 5 }, options);
    expect(await read()).toEqual({ id: 1, ...initial, checked_at: 5 });

    const beforeFailure = captureOpenClawStateWorkerContext(options);
    recordOpenClawStateDatabaseOpenFailure(options.path, new Error("catalog database refused"));
    await expect(readRemoteModelCatalogAsync(beforeFailure)).rejects.toThrow();
    await expect(read()).rejects.toThrow();
  });

  it("stores one machine-state snapshot and rejects stale refreshes", async () => {
    const root = tempDirs.make("openclaw-catalog-");
    const options = { path: path.join(root, "state.sqlite") };
    expect(readRemoteModelCatalog(options)).toBeUndefined();
    const initial = {
      bundle_json: '{"schemaVersion":1}',
      generated_at: 1,
      min_version: null,
      source_url: "https://catalog.test/one",
      etag: null,
      last_modified: null,
      checked_at: 2,
    };
    expect(
      await markRemoteModelCatalogCheckedAsync(
        1,
        { expected: initial },
        captureOpenClawStateWorkerContext(options),
      ),
    ).toBe(false);
    expect(readConfigMachineState("modelCatalog.remote.v3", options)).toBeUndefined();
    await writeRemoteModelCatalogAsync(initial, captureOpenClawStateWorkerContext(options));
    const updated = {
      ...initial,
      bundle_json: '{"schemaVersion":1,"updated":true}',
      generated_at: 3,
      min_version: "2026.7.0",
      source_url: "https://catalog.test/two",
      etag: '"two"',
      checked_at: 4,
    };
    await writeRemoteModelCatalogAsync(updated, captureOpenClawStateWorkerContext(options));
    const retained = await writeRemoteModelCatalogAsync(
      {
        ...updated,
        bundle_json: '{"schemaVersion":1,"older":true}',
        generated_at: 2,
        min_version: null,
        etag: '"older"',
        checked_at: 5,
      },
      captureOpenClawStateWorkerContext(options),
    );
    expect(retained).toMatchObject({ status: "retained-newer", row: { generated_at: 3 } });
    expect(
      await writeRemoteModelCatalogAsync(
        {
          ...updated,
          bundle_json: '{"schemaVersion":1,"sameGenerationDifferentBody":true}',
          min_version: null,
          etag: '"different"',
          checked_at: 5,
        },
        captureOpenClawStateWorkerContext(options),
      ),
    ).toMatchObject({
      status: "retained-newer",
      row: { bundle_json: expect.stringContaining("updated") },
    });
    // An unused older client's malformed bytes must not block a current-generation check.
    writeConfigMachineState("modelCatalog.remote.v2", null, options);
    runOpenClawStateWriteTransaction(({ db }) => {
      db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?").run(
        "{",
        "modelCatalog.remote.v2",
      );
    }, options);
    expect(readRemoteModelCatalog(options)?.generated_at).toBe(3);
    expect(
      await markRemoteModelCatalogCheckedAsync(
        5,
        { expected: { ...updated, etag: '"older"' } },
        captureOpenClawStateWorkerContext(options),
      ),
    ).toBe(false);
    expect(
      await markRemoteModelCatalogCheckedAsync(
        6,
        { expected: updated },
        captureOpenClawStateWorkerContext(options),
      ),
    ).toBe(true);
    expect(readRemoteModelCatalog(options)).toMatchObject({
      id: 1,
      generated_at: 3,
      source_url: "https://catalog.test/two",
      checked_at: 6,
    });
    expect(readConfigMachineState("modelCatalog.remote.v3", options)).toEqual({
      bundle_json: '{"schemaVersion":1,"updated":true}',
      generated_at: 3,
      min_version: "2026.7.0",
      source_url: "https://catalog.test/two",
      etag: '"two"',
      last_modified: null,
      checked_at: 6,
    });
    expect(
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => readConfigMachineStateRowInDatabase(db, "modelCatalog.remote.v2")?.value_json,
        options,
      ),
    ).toBe("{");
  });

  it.each(["modelCatalog.remote", "modelCatalog.remote.v2"])(
    "adopts %s without writing the older client slot",
    async (previousKey) => {
      const options = { path: path.join(tempDirs.make("openclaw-catalog-"), "state.sqlite") };
      const legacy = {
        bundle_json: '{"schemaVersion":1,"legacy":true}',
        generated_at: 100,
        min_version: "2026.7.0",
        source_url: "https://mirror.test/v1/catalog.json",
        etag: '"legacy"',
        last_modified: null,
        checked_at: 10,
      };
      writeConfigMachineState(previousKey, legacy, options);
      // Offline or unchanged mirrors keep their catalog across the upgrade.
      expect(readRemoteModelCatalog(options)).toEqual({ id: 1, ...legacy });
      // A 304 revalidation adopts the row into this client's slot.
      expect(
        await markRemoteModelCatalogCheckedAsync(
          20,
          { expected: legacy, etag: '"legacy"', lastModified: null },
          captureOpenClawStateWorkerContext(options),
        ),
      ).toBe(true);
      expect(readConfigMachineState("modelCatalog.remote.v3", options)).toEqual({
        ...legacy,
        checked_at: 20,
      });
      expect(readConfigMachineState(previousKey, options)).toEqual(legacy);
      // Once adopted, later writes by the older client no longer affect this client.
      writeConfigMachineState(previousKey, { ...legacy, generated_at: 200 }, options);
      expect(readRemoteModelCatalog(options)?.generated_at).toBe(100);
    },
  );

  it("leaves this client's slot empty when the older client's row no longer matches", async () => {
    const options = { path: path.join(tempDirs.make("openclaw-catalog-"), "state.sqlite") };
    const legacy = {
      bundle_json: '{"schemaVersion":1,"legacy":true}',
      generated_at: 100,
      min_version: null,
      source_url: "https://mirror.test/v1/catalog.json",
      etag: '"legacy"',
      last_modified: null,
      checked_at: 10,
    };
    // The older client refreshed between this client's read and its 304 check.
    const newer = { ...legacy, generated_at: 200, etag: '"newer"' };
    writeConfigMachineState("modelCatalog.remote", newer, options);
    expect(
      await markRemoteModelCatalogCheckedAsync(
        20,
        { expected: legacy, etag: '"legacy"', lastModified: null },
        captureOpenClawStateWorkerContext(options),
      ),
    ).toBe(false);
    expect(readConfigMachineState("modelCatalog.remote.v3", options)).toBeUndefined();
    // Until this client stores its own row, it keeps following the older client's slot.
    expect(readRemoteModelCatalog(options)).toEqual({ id: 1, ...newer });
    expect(readConfigMachineState("modelCatalog.remote", options)).toEqual(newer);
    const latest = { ...newer, generated_at: 300, etag: '"latest"' };
    writeConfigMachineState("modelCatalog.remote", latest, options);
    expect(readRemoteModelCatalog(options)).toEqual({ id: 1, ...latest });
    // markChecked retains its raw v2-slot precedence even when that payload parses as null.
    writeConfigMachineState("modelCatalog.remote.v2", null, options);
    expect(
      await markRemoteModelCatalogCheckedAsync(
        30,
        { expected: latest },
        captureOpenClawStateWorkerContext(options),
      ),
    ).toBe(false);
    expect(readConfigMachineState("modelCatalog.remote.v3", options)).toBeUndefined();
    expect(readRemoteModelCatalog(options)).toEqual({ id: 1, ...latest });
  });
});
