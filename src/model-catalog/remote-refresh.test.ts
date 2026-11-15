import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import * as machineState from "../state/config-machine-state-write.js";
import { readConfigMachineState as readState } from "../state/config-machine-state.js";
import { recordOpenClawStateDatabaseOpenFailure } from "../state/openclaw-state-db-cache.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext as workerContext } from "../state/openclaw-state-worker-context.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import * as bundledStamp from "./bundled-catalog-stamp.js";
import { resolveRemoteCatalogUrl } from "./remote-config.js";
import { refreshRemoteModelCatalog as refreshCatalog } from "./remote-refresh.js";
import {
  markRemoteModelCatalogCheckedAsync as markChecked,
  readRemoteModelCatalog as readCatalog,
  readRemoteModelCatalogAsync as readAsync,
  writeRemoteModelCatalogAsync as writeCatalog,
  type RemoteModelCatalogCheck,
} from "./remote-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const defaultUrl = resolveRemoteCatalogUrl({});
const bundle = {
  schemaVersion: 2,
  generatedAt: 1_753_500_000_000,
  minVersion: "2026.7.0",
  sourceCommit: "abc123",
  providers: { anthropic: {} },
  models: [{ id: "claude-test", provider: "anthropic", pricing: { status: "unknown" } }],
};

const options = () => ({ path: path.join(tempDirs.make("openclaw-refresh-"), "state.sqlite") });
let databaseOptions: ReturnType<typeof options>;
async function expectRefresh(
  expected: Partial<Awaited<ReturnType<typeof refreshCatalog>>>,
  config: Parameters<typeof refreshCatalog>[0]["config"] = {},
  force = true,
) {
  await expect(refreshCatalog({ config, databaseOptions, force })).resolves.toMatchObject(expected);
}
function mockFetch(implementation: typeof fetch) {
  const fetchImpl = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}
const mockDownload = (value: unknown = bundle, init?: ResponseInit) =>
  mockFetch(async () => new Response(JSON.stringify(value), init));

type StoredCatalog = Parameters<typeof writeCatalog>[0];
function storedCatalog(value = bundle, overrides: Partial<StoredCatalog> = {}) {
  return {
    bundle_json: JSON.stringify(value),
    generated_at: value.generatedAt,
    min_version: value.minVersion,
    source_url: defaultUrl,
    etag: null,
    last_modified: null,
    checked_at: Date.now(),
    ...overrides,
  };
}

const storeCatalog = (row: StoredCatalog) => writeCatalog(row, workerContext(databaseOptions));
const mirrorConfig = (suffix = "") => ({
  models: { catalogRefresh: { url: `https://mirror.example.test/${suffix}catalog.json` } },
});
const currentKey = "modelCatalog.remote.v3";
const previousKey = "modelCatalog.remote.v2";
const legacyKey = "modelCatalog.remote";
const initial: StoredCatalog = {
  bundle_json: '{"schemaVersion":1}',
  generated_at: 1,
  min_version: null,
  source_url: "https://catalog.test/one",
  etag: null,
  last_modified: null,
  checked_at: 2,
};
function store() {
  const db = options();
  const context = () => workerContext(db);
  return {
    db,
    read: () => readAsync(context()),
    write: (row: StoredCatalog) => writeCatalog(row, context()),
    check: (at: number, metadata: RemoteModelCatalogCheck) => markChecked(at, metadata, context()),
    state: (key = currentKey) => readState(key, db),
    put: (key: string, value: unknown) => machineState.writeConfigMachineState(key, value, db),
  };
}

afterEach(async () => {
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("remote model catalog refresh", () => {
  beforeEach(() => {
    databaseOptions = options();
    vi.spyOn(bundledStamp, "bundledCatalogGeneratedAt").mockReturnValue(bundle.generatedAt - 1);
  });

  it("bounds a stalled native body and preserves the stored catalog", async ({ signal }) => {
    const previous = storedCatalog();
    await storeCatalog(previous);
    const nativeFetch = globalThis.fetch;
    const headersReady = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    await withServer(
      (_request, response) => {
        response.once("close", closed.resolve);
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"schemaVersion":');
      },
      async (baseUrl) => {
        mockFetch(async (...args) => {
          try {
            const response = await nativeFetch(...args);
            headersReady.resolve();
            return response;
          } catch (error) {
            headersReady.reject(error);
            throw error;
          }
        });
        const controller = new AbortController();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const outcome = refreshCatalog({
          config: { models: { catalogRefresh: { url: `${baseUrl}/catalog.json` } } },
          databaseOptions,
          force: true,
          signal: controller.signal,
        });
        try {
          await withinTest(headersReady.promise, signal);
          await setImmediate();
          await vi.advanceTimersByTimeAsync(15_000);
          expect(await withinTest(outcome, signal)).toMatchObject({
            status: "error",
            error: expect.stringMatching(/abort|timed out/i),
          });
          await withinTest(closed.promise, signal);
          expect(readCatalog(databaseOptions)?.bundle_json).toBe(previous.bundle_json);
        } finally {
          controller.abort();
          vi.useRealTimers();
          await outcome;
        }
      },
    );
  });

  it("lets the caller release a contended writer while persistence waits", async () => {
    const database = stateDb.openOpenClawStateDatabase(databaseOptions);
    database.db.exec("PRAGMA busy_timeout=0");
    const competitor = new DatabaseSync(databaseOptions.path);
    const { port1, port2 } = new MessageChannel();
    const released = new Promise<void>((resolve) => {
      port1.once("message", () => {
        competitor.exec("ROLLBACK");
        resolve();
      });
    });
    mockFetch(async () => {
      competitor.exec("BEGIN IMMEDIATE");
      // Native port delivery needs a caller event-loop turn; no timer races the write.
      port2.postMessage("release");
      return new Response(JSON.stringify(bundle));
    });
    try {
      await expectRefresh({ status: "updated" });
      await released;
      expect(readCatalog(databaseOptions)?.generated_at).toBe(bundle.generatedAt);
    } finally {
      port1.removeAllListeners();
      port1.close();
      port2.close();
      if (competitor.isTransaction) {
        competitor.exec("ROLLBACK");
      }
      competitor.close();
    }
  });

  it("keeps the original physical store while the download yields", async () => {
    const original = databaseOptions;
    const replacement = options();
    databaseOptions = { ...original };
    mockFetch(async () => {
      databaseOptions.path = replacement.path;
      return new Response(JSON.stringify(bundle));
    });
    await expectRefresh({ status: "updated" });
    expect(readCatalog(original)?.generated_at).toBe(bundle.generatedAt);
    expect(readCatalog(replacement)).toBeUndefined();
  });

  it.each([
    [false, true, "disabled", 0],
    [true, false, "fresh", 0],
    [true, true, "unchanged", 1],
  ] as const)("refresh policy enabled=%s force=%s", async (enabled, force, status, calls) => {
    await storeCatalog(storedCatalog(bundle, { etag: '"one"' }));
    const fetchImpl = mockFetch(async () => new Response(null, { status: 304 }));
    await expectRefresh({ status }, { models: { catalogRefresh: { enabled } } }, force);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it("keeps a configured v1 mirror's pricing-only rows and sanitizes transport", async () => {
    const legacy = {
      ...bundle,
      schemaVersion: 1,
      models: undefined,
      providers: {
        anthropic: {
          baseUrl: "https://evil.test",
          headers: { Authorization: "bad" },
          models: [{ id: "claude-test", headers: { X: "bad" } }],
        },
      },
      pricing: { "anthropic/history-only": { input: 2, output: 8 } },
    };
    mockDownload(legacy);
    await expectRefresh({ status: "updated", providers: 1, models: 1 }, mirrorConfig("v1/"));
    const persisted = JSON.parse(readCatalog(databaseOptions)?.bundle_json ?? "null");
    expect(persisted.pricing).toEqual(legacy.pricing);
    expect(persisted.providers.anthropic).not.toHaveProperty("baseUrl");
    expect(persisted.providers.anthropic.models[0]).not.toHaveProperty("headers");
  });

  it("does not report a catalog older than the bundled build as applicable", async () => {
    mockDownload();
    vi.mocked(bundledStamp.bundledCatalogGeneratedAt).mockReturnValue(bundle.generatedAt);
    await expectRefresh({ status: "unchanged", generatedAt: bundle.generatedAt });
  });

  it("treats another source URL as unrelated and rejects rollback", async () => {
    const newerBundle = { ...bundle, generatedAt: bundle.generatedAt + 100 };
    await storeCatalog(storedCatalog(newerBundle, { etag: '"newer"' }));
    mockDownload();
    await expectRefresh({ status: "unchanged", generatedAt: newerBundle.generatedAt });
    expect(readCatalog(databaseOptions)?.generated_at).toBe(newerBundle.generatedAt);

    const mirrorBundle = { ...bundle, generatedAt: newerBundle.generatedAt + 100 };
    mockDownload(mirrorBundle);
    await expectRefresh(
      { status: "updated", generatedAt: mirrorBundle.generatedAt },
      mirrorConfig(),
      false,
    );
  });

  it.each([
    ["invalid JSON", async () => new Response("not json")],
    ["newer minVersion", async () => Response.json({ ...bundle, minVersion: "9999.1.1" })],
    [
      "timeout",
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ],
    ["invalid UTF-8", async () => new Response(Uint8Array.of(0xff))],
    ["invalid schema", async () => Response.json({ ...bundle, models: [] })],
    ["unsupported schemaVersion", async () => Response.json({ ...bundle, schemaVersion: 4 })],
  ] satisfies Array<[string, typeof fetch]>)(
    "preserves the previous catalog without a fallback request after %s",
    async (_failure, fetch) => {
      const previous = storedCatalog(bundle, {
        etag: '"previous"',
        last_modified: "Wed, 23 Jul 2025 00:00:00 GMT",
        checked_at: 10_000,
      });
      await storeCatalog(previous);

      const fetchImpl = mockFetch(fetch);
      await expectRefresh({ status: "error" });
      expect(readCatalog(databaseOptions)).toMatchObject(previous);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
});

describe("remote model catalog store", () => {
  it("keeps snapshots detached across stores, commits, and retirement", async () => {
    const { db, read, write, check, put } = store();
    const other = store();
    put("fixture.unrelated", true);
    expect(await read()).toBeUndefined();
    expect(await read()).toBeUndefined(); // Retain the cached-absence branch.
    await write(initial);
    expect(await read()).toEqual({ id: 1, ...initial });
    expect(await other.read()).toBeUndefined();
    const retained = await read();
    retained!.checked_at = -1;
    expect(await read()).toEqual({ id: 1, ...initial });
    await expect(withArtifactPreservingStateReads(read)).resolves.toEqual({ id: 1, ...initial });
    const inspection = withArtifactPreservingStateReads(() => workerContext(db), {
      agentDatabases: true,
    });
    expect(await readAsync(inspection)).toEqual({ id: 1, ...initial });
    await check(3, { expected: initial });
    expect(await read()).toEqual({ id: 1, ...initial, checked_at: 3 });
    expect(() =>
      stateDb.runOpenClawStateWriteTransaction(() => {
        put(currentKey, { ...initial, checked_at: 4 });
        throw new Error("rollback catalog");
      }, db),
    ).toThrow("rollback catalog");
    expect(await read()).toEqual({ id: 1, ...initial, checked_at: 3 });
    machineState.deleteConfigMachineState(currentKey, db);
    expect(await read()).toBeUndefined();
    machineState.importConfigMachineState([[previousKey, initial]], db);
    expect(await read()).toEqual({ id: 1, ...initial });
    put(previousKey, null);
    put(legacyKey, { ...initial, checked_at: 5 });
    expect(await read()).toEqual({ id: 1, ...initial, checked_at: 5 });
    const beforeFailure = workerContext(db);
    recordOpenClawStateDatabaseOpenFailure(db.path, new Error("catalog database refused"));
    await expect(readAsync(beforeFailure)).rejects.toThrow();
    await expect(read()).rejects.toThrow();
  });

  it("stores one machine-state snapshot and rejects stale refreshes", async () => {
    const { db, write, check, state, put } = store();
    expect(readCatalog(db)).toBeUndefined();
    expect(await check(1, { expected: initial })).toBe(false);
    expect(state()).toBeUndefined();
    await write(initial);
    const updated = {
      ...initial,
      bundle_json: '{"schemaVersion":1,"updated":true}',
      generated_at: 3,
      etag: '"two"',
      checked_at: 4,
    };
    await write(updated);
    for (const candidate of [
      { generated_at: 2, bundle_json: '{"schemaVersion":1,"older":true}', etag: '"older"' },
      { generated_at: 3, bundle_json: '{"sameGenerationDifferentBody":true}', etag: '"different"' },
    ]) {
      expect(await write({ ...updated, ...candidate, checked_at: 5 })).toMatchObject({
        status: "retained-newer",
        row: updated,
      });
    }
    // Malformed bytes belonging to an older client cannot block a current-generation check.
    put(previousKey, null);
    const sql = stateDb.openOpenClawStateDatabase(db).db;
    sql
      .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
      .run("{", previousKey);
    expect(readCatalog(db)?.generated_at).toBe(3);
    expect(await check(5, { expected: { ...updated, etag: '"older"' } })).toBe(false);
    expect(await check(6, { expected: updated })).toBe(true);
    const checked = { ...updated, checked_at: 6 };
    expect(state()).toEqual(checked);
    expect(
      sql
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get(previousKey),
    ).toEqual({ value_json: "{" });
  });

  it.each([legacyKey, previousKey])(
    "adopts only matching %s rows without writing the older client slot",
    async (key) => {
      const { db, check, state, put } = store();
      const previous = { ...initial, generated_at: 100, min_version: "2026.7.0" };
      put(key, previous);
      expect(readCatalog(db)).toEqual({ id: 1, ...previous });
      expect(await check(10, { expected: { ...previous, generated_at: 0 } })).toBe(false);
      expect(state()).toBeUndefined();
      const latest = { ...previous, generated_at: 300, etag: '"latest"' };
      put(key, latest);
      expect(readCatalog(db)).toEqual({ id: 1, ...latest });
      if (key === legacyKey) {
        // Raw v2 precedence survives a null payload, while reads still fall back to v1.
        put(previousKey, null);
        expect(await check(15, { expected: latest })).toBe(false);
        expect(state()).toBeUndefined();
        expect(readCatalog(db)).toEqual({ id: 1, ...latest });
        machineState.deleteConfigMachineState(previousKey, db);
      }
      expect(await check(20, { expected: latest, etag: '"latest"', lastModified: null })).toBe(
        true,
      );
      expect(state()).toEqual({ ...latest, checked_at: 20 });
      expect(state(key)).toEqual(latest);
      put(key, { ...latest, generated_at: 400 });
      expect(readCatalog(db)?.generated_at).toBe(300);
    },
  );
});
