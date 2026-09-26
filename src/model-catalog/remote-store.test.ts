import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  markRemoteModelCatalogChecked,
  readRemoteModelCatalog,
  writeRemoteModelCatalog,
} from "./remote-store.js";

// Registered first so it removes directories after the database closes below.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const roots: string[] = [];
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("remote model catalog store", () => {
  it("stores one machine-state snapshot and rejects stale refreshes", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-")));
    roots.push(root);
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
    expect(markRemoteModelCatalogChecked(1, { expected: initial }, options)).toBe(false);
    expect(readConfigMachineState("modelCatalog.remote.v2", options)).toBeUndefined();
    writeRemoteModelCatalog(initial, options);
    const updated = {
      ...initial,
      bundle_json: '{"schemaVersion":1,"updated":true}',
      generated_at: 3,
      min_version: "2026.7.0",
      source_url: "https://catalog.test/two",
      etag: '"two"',
      checked_at: 4,
    };
    writeRemoteModelCatalog(updated, options);
    const retained = writeRemoteModelCatalog(
      {
        ...updated,
        bundle_json: '{"schemaVersion":1,"older":true}',
        generated_at: 2,
        min_version: null,
        etag: '"older"',
        checked_at: 5,
      },
      options,
    );
    expect(retained).toMatchObject({ status: "retained-newer", row: { generated_at: 3 } });
    expect(
      writeRemoteModelCatalog(
        {
          ...updated,
          bundle_json: '{"schemaVersion":1,"sameGenerationDifferentBody":true}',
          min_version: null,
          etag: '"different"',
          checked_at: 5,
        },
        options,
      ),
    ).toMatchObject({
      status: "retained-newer",
      row: { bundle_json: expect.stringContaining("updated") },
    });
    expect(
      markRemoteModelCatalogChecked(5, { expected: { ...updated, etag: '"older"' } }, options),
    ).toBe(false);
    expect(markRemoteModelCatalogChecked(6, { expected: updated }, options)).toBe(true);
    expect(readRemoteModelCatalog(options)).toMatchObject({
      id: 1,
      generated_at: 3,
      source_url: "https://catalog.test/two",
      checked_at: 6,
    });
    expect(readConfigMachineState("modelCatalog.remote.v2", options)).toEqual({
      bundle_json: '{"schemaVersion":1,"updated":true}',
      generated_at: 3,
      min_version: "2026.7.0",
      source_url: "https://catalog.test/two",
      etag: '"two"',
      last_modified: null,
      checked_at: 6,
    });
  });

  it("serves an upgraded install from the older client's row without writing it", () => {
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
    writeConfigMachineState("modelCatalog.remote", legacy, options);
    // Offline or unchanged mirrors keep their catalog across the upgrade.
    expect(readRemoteModelCatalog(options)).toEqual({ id: 1, ...legacy });
    // A 304 revalidation adopts the row into this client's slot.
    expect(
      markRemoteModelCatalogChecked(
        20,
        { expected: legacy, etag: '"legacy"', lastModified: null },
        options,
      ),
    ).toBe(true);
    expect(readConfigMachineState("modelCatalog.remote.v2", options)).toEqual({
      ...legacy,
      checked_at: 20,
    });
    expect(readConfigMachineState("modelCatalog.remote", options)).toEqual(legacy);
    // Once adopted, later writes by the older client no longer affect this client.
    writeConfigMachineState("modelCatalog.remote", { ...legacy, generated_at: 200 }, options);
    expect(readRemoteModelCatalog(options)?.generated_at).toBe(100);
  });

  it("leaves this client's slot empty when the older client's row no longer matches", () => {
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
      markRemoteModelCatalogChecked(
        20,
        { expected: legacy, etag: '"legacy"', lastModified: null },
        options,
      ),
    ).toBe(false);
    expect(readConfigMachineState("modelCatalog.remote.v2", options)).toBeUndefined();
    // Until this client stores its own row, it keeps following the older client's slot.
    expect(readRemoteModelCatalog(options)).toEqual({ id: 1, ...newer });
    expect(readConfigMachineState("modelCatalog.remote", options)).toEqual(newer);
    const latest = { ...newer, generated_at: 300, etag: '"latest"' };
    writeConfigMachineState("modelCatalog.remote", latest, options);
    expect(readRemoteModelCatalog(options)).toEqual({ id: 1, ...latest });
  });
});
