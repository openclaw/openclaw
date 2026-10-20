import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { MessageChannel } from "node:worker_threads";
import {
  parseRemoteModelCatalogBundle as parseV1,
  parseRemoteModelCatalogBundleV2 as parseV2,
} from "@openclaw/model-catalog-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext as workerContext } from "../state/openclaw-state-worker-context.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as bundledStamp from "./bundled-catalog-stamp.js";
import { resolveRemoteCatalogUrl } from "./remote-config.js";
import { refreshRemoteModelCatalog as refreshCatalog } from "./remote-refresh.js";
import {
  readRemoteModelCatalog as readCatalog,
  writeRemoteModelCatalogAsync as writeCatalog,
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

beforeEach(() => {
  databaseOptions = options();
  vi.spyOn(bundledStamp, "bundledCatalogGeneratedAt").mockReturnValue(bundle.generatedAt - 1);
});

afterEach(async () => {
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("remote model catalog refresh", () => {
  it("bounds a native stalled body after headers without overwriting the stored catalog", async ({
    signal,
  }) => {
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
      ["modelCatalog.remote.v2", previous, bundle, parseV2],
      ["modelCatalog.remote", legacy, legacyBundle, parseV1],
    ] as const;
    for (const [key, record] of slots) {
      writeConfigMachineState(key, record, databaseOptions);
    }
    const downloaded = {
      ...bundle,
      schemaVersion: 3,
      models: [
        {
          ...bundle.models[0],
          inference: {
            chat: false,
            decision: {
              protocol: "fixture.decisions",
              input: ["text"],
              questions: { boolean: { probabilities: "boolean", abstention: false } },
              billing: {
                unit: "tokens",
                source: "provider-docs",
                usdPerMillion: { input: 0, output: 0 },
              },
            },
          },
        },
      ],
    };
    const config = mirrorConfig("v3/");
    const fetchImpl = mockFetch(async () => Response.json(downloaded));
    await expectRefresh({ status: "updated", models: 1 }, config);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(readCatalog(databaseOptions)?.bundle_json ?? "null")).toEqual(downloaded);
    for (const [key, record, expected, parse] of slots) {
      const retained = readConfigMachineState<typeof record>(key, databaseOptions);
      expect(retained).toEqual(record);
      expect(parse(JSON.parse(retained!.bundle_json))).toEqual(expected);
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

  it.each(["invalid UTF-8", "unsupported schema", "empty models", "rates on unknown pricing"])(
    "preserves the previous catalog without a fallback request after %s",
    async (failure) => {
      const previous = storedCatalog(bundle, {
        etag: '"previous"',
        last_modified: "Wed, 23 Jul 2025 00:00:00 GMT",
        checked_at: 10_000,
      });
      await storeCatalog(previous);

      const corrupt = Buffer.from(
        JSON.stringify({
          ...bundle,
          generatedAt: bundle.generatedAt + 1,
          ...(failure === "unsupported schema" ? { schemaVersion: 4 } : {}),
          ...(failure === "empty models" ? { models: [] } : {}),
          ...(failure === "rates on unknown pricing"
            ? { models: [{ ...bundle.models[0], pricing: { status: "unknown", input: 0 } }] }
            : {}),
        }),
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
