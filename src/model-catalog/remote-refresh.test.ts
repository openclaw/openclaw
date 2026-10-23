import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import {
  deleteConfigMachineState,
  importConfigMachineState,
  writeConfigMachineState as writeState,
} from "../state/config-machine-state-write.js";
import {
  readConfigMachineState as readState,
  readConfigMachineStateRowInDatabase,
} from "../state/config-machine-state.js";
import { recordOpenClawStateDatabaseOpenFailure } from "../state/openclaw-state-db-cache.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext as workerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
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

function options() {
  return { path: path.join(tempDirs.make("openclaw-refresh-"), "state.sqlite") };
}
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
function mockDownload(value: unknown = bundle, init?: ResponseInit) {
  return mockFetch(async () => new Response(JSON.stringify(value), init));
}

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

function storeCatalog(record: StoredCatalog) {
  return writeCatalog(record, workerContext(databaseOptions));
}
function mirrorConfig(suffix = "") {
  return {
    models: { catalogRefresh: { url: `https://mirror.example.test/${suffix}catalog.json` } },
  };
}
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
const storedLegacy = {
  ...initial,
  bundle_json: '{"schemaVersion":1,"legacy":true}',
  generated_at: 100,
  source_url: "https://mirror.test/v1/catalog.json",
  etag: '"legacy"',
  checked_at: 10,
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
    put: (key: string, value: unknown) => writeState(key, value, db),
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
    const database = openOpenClawStateDatabase(databaseOptions);
    database.db.exec("PRAGMA busy_timeout=0");
    const competitor = new DatabaseSync(databaseOptions.path);
    const { port1, port2 } = new MessageChannel();
    const released = new Promise<void>((resolve) => {
      port1.once("message", () => {
        competitor.exec("ROLLBACK");
        resolve();
      });
    });
    const fetchImpl = mockFetch(async () => {
      competitor.exec("BEGIN IMMEDIATE");
      // Native port delivery needs a caller event-loop turn; no timer races the write.
      port2.postMessage("release");
      return new Response(JSON.stringify(bundle));
    });
    try {
      await expectRefresh({ status: "updated" });
      await released;
      expect(fetchImpl).toHaveBeenCalledOnce();
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

  it("persists valid rows and revalidates without caller-thread SQL", async () => {
    const downloaded = {
      ...bundle,
      models: [
        { ...bundle.models[0], input: ["text", "future"] },
        { id: "bad-pricing", provider: "anthropic", pricing: { status: "unknown", input: 0 } },
      ],
    };
    openOpenClawStateDatabase(databaseOptions);
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      const fetchImpl = mockDownload(downloaded, { status: 200, headers: { etag: '"two"' } });
      await expectRefresh({ status: "updated", providers: 1, models: 1 });
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        "https://catalog.openclaw.ai/models/v2/catalog.json",
      );
      mockFetch(async () => new Response(null, { status: 304 }));
      await expectRefresh({ status: "unchanged" });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(JSON.parse(readCatalog(databaseOptions)?.bundle_json ?? "null")).toEqual({
      ...bundle,
      models: [{ ...bundle.models[0], input: ["text"] }],
    });
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

  it("does not invoke fetch when disabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    await expect(
      refreshCatalog({
        config: { models: { catalogRefresh: { enabled: false } } },
      }),
    ).resolves.toMatchObject({ status: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips fresh rows and force bypasses the TTL", async () => {
    await storeCatalog(storedCatalog(bundle, { etag: '"one"' }));
    const fetchImpl = mockFetch(async () => new Response(null, { status: 304 }));
    await expectRefresh({ status: "fresh" }, {}, false);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expectRefresh({ status: "unchanged" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("stores configured v3 capabilities without changing either released client slot", async () => {
    const legacyBundle = {
      schemaVersion: 1,
      generatedAt: bundle.generatedAt,
      sourceCommit: bundle.sourceCommit,
      providers: { anthropic: { models: [{ id: "claude-test" }] } },
    };
    const previous = storedCatalog(bundle, { min_version: null, checked_at: 1 });
    const legacy = { ...previous, bundle_json: JSON.stringify(legacyBundle) };
    const slots = [
      [previousKey, previous],
      [legacyKey, legacy],
    ] as const;
    for (const [key, record] of slots) {
      writeState(key, record, databaseOptions);
    }
    const decision = {
      protocol: "fixture.decisions",
      input: ["text"],
      questions: { boolean: { probabilities: "boolean", abstention: false } },
      billing: {
        unit: "tokens",
        source: "provider-docs",
        usdPerMillion: { input: 0, output: 0 },
      },
    };
    const inference = { chat: false, decision };
    const models = [{ ...bundle.models[0], inference }];
    const downloaded = { ...bundle, schemaVersion: 3, models };
    const config = mirrorConfig("v3/");
    mockDownload(downloaded);
    await expectRefresh({ status: "updated", models: 1 }, config);
    expect(JSON.parse(readCatalog(databaseOptions)?.bundle_json ?? "null")).toEqual(downloaded);
    for (const [key, record] of slots) {
      expect(readState(key, databaseOptions)).toEqual(record);
    }
    mockFetch(async () => {
      throw new Error("fresh v3 must not fetch");
    });
    await expectRefresh({ status: "fresh", models: 1 }, config, false);
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
    const fetchImpl = mockDownload(legacy);
    await expectRefresh({ status: "updated", providers: 1, models: 1 }, mirrorConfig("v1/"));
    const persisted = JSON.parse(readCatalog(databaseOptions)?.bundle_json ?? "null");
    expect(persisted.pricing).toEqual(legacy.pricing);
    expect(persisted.providers.anthropic).not.toHaveProperty("baseUrl");
    expect(persisted.providers.anthropic.models[0]).not.toHaveProperty("headers");
    expect(fetchImpl).toHaveBeenCalledOnce();
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
    await expectRefresh({
      status: "unchanged",
      generatedAt: newerBundle.generatedAt,
    });
    expect(readCatalog(databaseOptions)?.generated_at).toBe(newerBundle.generatedAt);

    const mirrorBundle = { ...bundle, generatedAt: newerBundle.generatedAt + 100 };
    const mirrorFetch = mockDownload(mirrorBundle);
    await expectRefresh(
      { status: "updated", generatedAt: mirrorBundle.generatedAt },
      mirrorConfig(),
      false,
    );
    expect(mirrorFetch).toHaveBeenCalledOnce();
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
  ] satisfies Array<[string, typeof fetch]>)(
    "returns a typed failure for %s",
    async (_name, fetch) => {
      mockFetch(fetch);
      await expectRefresh({ status: "error" });
    },
  );

  it.each([
    ["invalid UTF-8", {}],
    ["unsupported schema", { schemaVersion: 4 }],
    ["empty models", { models: [] }],
    [
      "rates on unknown pricing",
      { models: [{ ...bundle.models[0], pricing: { status: "unknown", input: 0 } }] },
    ],
  ] as const)(
    "preserves the previous catalog without a fallback request after %s",
    async (failure, patch) => {
      const previous = storedCatalog(bundle, {
        etag: '"previous"',
        last_modified: "Wed, 23 Jul 2025 00:00:00 GMT",
        checked_at: 10_000,
      });
      await storeCatalog(previous);

      const corrupt = Buffer.from(
        JSON.stringify({ ...bundle, generatedAt: bundle.generatedAt + 1, ...patch }),
      );
      if (failure === "invalid UTF-8") {
        const modelIdOffset = corrupt.indexOf("claude-test");
        expect(modelIdOffset).toBeGreaterThanOrEqual(0);
        corrupt[modelIdOffset + "claude-".length] = 0xff;
      }

      const fetchImpl = mockFetch(async () => new Response(corrupt, { status: 200 }));
      await expectRefresh({ status: "error" });
      expect(readCatalog(databaseOptions)).toMatchObject(previous);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
});

describe("remote model catalog store", () => {
  it("reuses published rows across unrelated writes and follows committed replacements", async () => {
    const { db, read, write, check, put } = store();
    const other = store();
    put("fixture.unrelated", true);
    other.put("fixture.unrelated", true);
    const operations = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
    async function expectCached(
      expected: Awaited<ReturnType<typeof read>>,
      calls: number,
      reader = read,
    ) {
      expect(await reader()).toEqual(expected);
      expect(operations).toHaveBeenCalledTimes(calls);
      operations.mockClear();
    }
    expect(await read()).toBeUndefined();
    operations.mockClear();
    await expectCached(undefined, 1, other.read);
    put("fixture.unrelated", false);
    await expectCached(undefined, 0);
    await write(initial);
    expect(await read()).toEqual({ id: 1, ...initial });
    operations.mockClear();
    const retained = await read();
    retained!.checked_at = -1;
    await expectCached({ id: 1, ...initial }, 0);
    const selected = withDatabaseEngineSelection(
      { effectiveEngines: resolveDatabaseFamilyEngines({}) },
      () => workerContext(db),
    );
    await expectCached({ id: 1, ...initial }, 1, () => readAsync(selected));
    await expectCached({ id: 1, ...initial }, 0);
    await expectCached({ id: 1, ...initial }, 0, () => readAsync(selected));
    await withArtifactPreservingStateReads(read);
    const inspection = withArtifactPreservingStateReads(() => workerContext(db), {
      agentDatabases: true,
    });
    await readAsync(inspection);
    expect(operations).toHaveBeenCalledTimes(2);
    await check(3, { expected: initial });
    expect(await read()).toEqual({ id: 1, ...initial, checked_at: 3 });
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        put(currentKey, { ...initial, checked_at: 4 });
        throw new Error("rollback catalog");
      }, db),
    ).toThrow("rollback catalog");
    expect(await read()).toEqual({ id: 1, ...initial, checked_at: 3 });
    deleteConfigMachineState(currentKey, db);
    expect(await read()).toBeUndefined();
    importConfigMachineState([[previousKey, initial]], db);
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
      min_version: "2026.7.0",
      source_url: "https://catalog.test/two",
      etag: '"two"',
      checked_at: 4,
    };
    await write(updated);
    for (const candidate of [
      { generated_at: 2, bundle_json: '{"schemaVersion":1,"older":true}', etag: '"older"' },
      { generated_at: 3, bundle_json: '{"sameGenerationDifferentBody":true}', etag: '"different"' },
    ]) {
      expect(
        await write({ ...updated, ...candidate, min_version: null, checked_at: 5 }),
      ).toMatchObject({ status: "retained-newer", row: updated });
    }
    // Malformed bytes belonging to an older client cannot block a current-generation check.
    put(previousKey, null);
    runOpenClawStateWriteTransaction(({ db: sql }) => {
      sql
        .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
        .run("{", previousKey);
    }, db);
    expect(readCatalog(db)?.generated_at).toBe(3);
    expect(await check(5, { expected: { ...updated, etag: '"older"' } })).toBe(false);
    expect(await check(6, { expected: updated })).toBe(true);
    const checked = { ...updated, checked_at: 6 };
    expect(readCatalog(db)).toMatchObject({ id: 1, ...checked });
    expect(state()).toEqual(checked);
    expect(
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db: sql }) => readConfigMachineStateRowInDatabase(sql, previousKey)?.value_json,
        db,
      ),
    ).toBe("{");
  });

  it.each([legacyKey, previousKey])(
    "adopts %s without writing the older client slot",
    async (key) => {
      const { db, check, state, put } = store();
      const previous = { ...storedLegacy, min_version: "2026.7.0" };
      put(key, previous);
      expect(readCatalog(db)).toEqual({ id: 1, ...previous });
      await expect(
        check(20, { expected: previous, etag: '"legacy"', lastModified: null }),
      ).resolves.toBe(true);
      expect(state()).toEqual({ ...previous, checked_at: 20 });
      expect(state(key)).toEqual(previous);
      put(key, { ...previous, generated_at: 200 });
      expect(readCatalog(db)?.generated_at).toBe(100);
    },
  );

  it("leaves this client's slot empty when the older client's row no longer matches", async () => {
    const { db, check, state, put } = store();
    const newer = { ...storedLegacy, generated_at: 200, etag: '"newer"' };
    put(legacyKey, newer);
    expect(await check(20, { expected: storedLegacy, etag: '"legacy"', lastModified: null })).toBe(
      false,
    );
    expect(state()).toBeUndefined();
    expect(readCatalog(db)).toEqual({ id: 1, ...newer });
    expect(state(legacyKey)).toEqual(newer);
    const latest = { ...newer, generated_at: 300, etag: '"latest"' };
    put(legacyKey, latest);
    expect(readCatalog(db)).toEqual({ id: 1, ...latest });
    // markChecked keeps raw v2 precedence even when that payload parses as null.
    put(previousKey, null);
    expect(await check(30, { expected: latest })).toBe(false);
    expect(state()).toBeUndefined();
    expect(readCatalog(db)).toEqual({ id: 1, ...latest });
  });
});
