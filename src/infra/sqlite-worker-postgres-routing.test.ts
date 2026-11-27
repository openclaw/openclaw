import assert from "node:assert/strict";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { createSqliteFamilyEngines } from "./database-engine/selection-fixture.test-support.js";
import { openEngineWorkerStore } from "./database-engine/worker-store.js";
import { initializeGatewayResourceProfile } from "./gateway-resource-profile.js";
import * as pool from "./postgres-sync/pool.js";
import * as sharedHost from "./shared-worker-host.js";
import {
  useSqliteWorkerStoreFixture,
  readWorkerRows,
} from "./sqlite-worker-fixture.test-support.js";
import { openSharedStateSqliteWorkerStore, openSqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

const { databasePath, stores } = useSqliteWorkerStoreFixture("sqlite-worker-placement-");
const capabilities = await initializeSqliteRuntimeCapabilities();

it.runIf(capabilities.explicitSqliteCloseReleasesNativeResources)(
  "keeps a warm parent pool off the shared host and lends its services to an explicit plugin opener",
  async () => {
    const file = databasePath();
    const moduleUrl = new URL("./sqlite-worker-store.test-support.ts", import.meta.url);
    initializeGatewayResourceProfile({ profile: "lean" });
    using attach = vi.spyOn(sharedHost, "createHostedWorker");
    using post = vi.spyOn(sharedHost.HostedWorkerEndpoint.prototype, "postMessage");
    using endpoints = vi.spyOn(pool, "createPostgresWorkerPoolEndpoints");
    try {
      const services = pool.getPostgresPool().services;
      const sqlite = await openSharedStateSqliteWorkerStore<FixtureOperations>(
        { moduleUrl, databasePath: file },
        {
          environment: { OPENCLAW_STATE_DIR: path.dirname(file) },
          databaseEngineSelection: { effectiveEngines: createSqliteFamilyEngines() },
        },
      );
      assert.ok(sqlite);
      stores.add(sqlite);
      expect(await readWorkerRows(sqlite)).toEqual([]);
      expect(attach).toHaveBeenCalledExactlyOnceWith(
        expect.any(URL),
        {},
        expect.objectContaining({ key: "sqlite-store:shared-state" }),
      );
      expect(post.mock.calls.map(([request]) => isRecord(request) && request.type)).toEqual(
        expect.arrayContaining(["open", "execute"]),
      );
      expect(
        post.mock.calls.every(
          ([request]) => isRecord(request) && request.postgresPool === undefined,
        ),
      ).toBe(true);
      expect(endpoints).not.toHaveBeenCalled();

      // Lazy plugin stores can carry a family input even with no ambient PG selection.
      const pg = await openEngineWorkerStore<FixtureOperations>(
        { moduleUrl, databasePath: databasePath(), input: undefined },
        { connection: "postgresql://localhost/unused", schemaPrefix: "fixture" },
      );
      stores.add(pg);
      expect(await readWorkerRows(pg)).toEqual([]);
      expect(attach).toHaveBeenCalledTimes(1);
      expect(services).toHaveLength(4);
      expect(endpoints).toHaveBeenCalledExactlyOnceWith(true);
      expect(endpoints.mock.results[0]?.value?.services.map(({ signal }) => signal)).toEqual(
        services.map(({ signal }) => signal),
      );
    } finally {
      try {
        await Promise.all([...stores].map((store) => store.close()));
        stores.clear();
      } finally {
        await pool.closePostgresPool();
        initializeGatewayResourceProfile({ profile: "standard" });
      }
    }
  },
);

it("delivers the PG pool on the first command after an explicit family joins a pool-less dedicated actor", async () => {
  initializeGatewayResourceProfile({ profile: "standard" });
  const options = {
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: databasePath(),
    input: undefined,
  };
  using endpoints = vi.spyOn(pool, "createPostgresWorkerPoolEndpoints");
  const ordinary = await openSqliteWorkerStore<FixtureOperations>(options);
  stores.add(ordinary);
  try {
    expect(await readWorkerRows(ordinary)).toEqual([]);
    expect(endpoints.mock.results.every((result) => result.value === undefined)).toBe(true);
    endpoints.mockClear();
    const joined = await openEngineWorkerStore<FixtureOperations>(options, {
      connection: "postgresql://localhost/unused",
      schemaPrefix: "fixture",
    });
    stores.add(joined);
    expect(endpoints).not.toHaveBeenCalled();
    expect(await readWorkerRows(joined)).toEqual([]);
    expect(endpoints).toHaveBeenCalledExactlyOnceWith(true);
    expect(endpoints.mock.results[0]?.value?.services).toHaveLength(4);
  } finally {
    try {
      await Promise.all([...stores].map((store) => store.close()));
      stores.clear();
    } finally {
      await pool.closePostgresPool();
    }
  }
});
