import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveRemoteCatalogUrl } from "./remote-config.js";
import { refreshRemoteModelCatalog, REMOTE_MODEL_CATALOG_TTL_MS } from "./remote-refresh.js";
import { readRemoteModelCatalog, writeRemoteModelCatalog } from "./remote-store.js";

const roots: string[] = [];
const DEFAULT_REMOTE_MODEL_CATALOG_URL = resolveRemoteCatalogUrl({});
const bundle = {
  schemaVersion: 2,
  generatedAt: 1_753_500_000_000,
  minVersion: "2026.7.0",
  sourceCommit: "abc123",
  providers: { anthropic: {} },
  models: [{ id: "claude-test", provider: "anthropic", pricing: { status: "unknown" } }],
};

function options() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-refresh-")));
  roots.push(root);
  return { path: path.join(root, "state.sqlite") };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("remote model catalog refresh", () => {
  it("does not invoke fetch when disabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      refreshRemoteModelCatalog({
        config: { models: { catalogRefresh: { enabled: false } } },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ status: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips fresh rows and force bypasses the TTL", async () => {
    const databaseOptions = options();
    writeRemoteModelCatalog(
      {
        bundle_json: JSON.stringify(bundle),
        generated_at: bundle.generatedAt,
        min_version: bundle.minVersion,
        source_url: DEFAULT_REMOTE_MODEL_CATALOG_URL,
        etag: '"one"',
        last_modified: null,
        checked_at: 10_000,
      },
      databaseOptions,
    );
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 304 }));
    await expect(
      refreshRemoteModelCatalog({ config: {}, fetchImpl, databaseOptions, now: () => 10_001 }),
    ).resolves.toMatchObject({ status: "fresh" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      refreshRemoteModelCatalog({
        config: {},
        fetchImpl,
        databaseOptions,
        force: true,
        now: () => 10_001 + REMOTE_MODEL_CATALOG_TTL_MS,
      }),
    ).resolves.toMatchObject({ status: "unchanged" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("downloads v2 by default and persists inline pricing", async () => {
    const databaseOptions = options();
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(bundle), { status: 200, headers: { etag: '"two"' } }),
    );
    await expect(
      refreshRemoteModelCatalog({
        config: {},
        fetchImpl,
        databaseOptions,
        force: true,
        bundledGeneratedAt: () => bundle.generatedAt - 1,
      }),
    ).resolves.toMatchObject({ status: "updated", providers: 1, models: 1 });
    const persisted = JSON.parse(readRemoteModelCatalog(databaseOptions)?.bundle_json ?? "null");
    expect(persisted).toEqual(bundle);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://catalog.openclaw.ai/models/v2/catalog.json");
  });

  it("keeps a configured v1 mirror's pricing-only rows and sanitizes transport", async () => {
    const databaseOptions = options();
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
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(legacy)));
    await expect(
      refreshRemoteModelCatalog({
        config: {
          models: { catalogRefresh: { url: "https://mirror.example.test/v1/catalog.json" } },
        },
        fetchImpl,
        databaseOptions,
        force: true,
        bundledGeneratedAt: () => bundle.generatedAt - 1,
      }),
    ).resolves.toMatchObject({ status: "updated", providers: 1, models: 1 });
    const persisted = JSON.parse(readRemoteModelCatalog(databaseOptions)?.bundle_json ?? "null");
    expect(persisted.pricing).toEqual(legacy.pricing);
    expect(persisted.providers.anthropic).not.toHaveProperty("baseUrl");
    expect(persisted.providers.anthropic.models[0]).not.toHaveProperty("headers");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not report a catalog older than the bundled build as applicable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(bundle)));
    await expect(
      refreshRemoteModelCatalog({
        config: {},
        fetchImpl,
        databaseOptions: options(),
        force: true,
        bundledGeneratedAt: () => bundle.generatedAt,
      }),
    ).resolves.toMatchObject({ status: "unchanged", generatedAt: bundle.generatedAt });
  });

  it("treats another source URL as unrelated and rejects rollback", async () => {
    const databaseOptions = options();
    const newerBundle = { ...bundle, generatedAt: bundle.generatedAt + 100 };
    writeRemoteModelCatalog(
      {
        bundle_json: JSON.stringify(newerBundle),
        generated_at: newerBundle.generatedAt,
        min_version: newerBundle.minVersion,
        source_url: DEFAULT_REMOTE_MODEL_CATALOG_URL,
        etag: '"newer"',
        last_modified: null,
        checked_at: 10_000,
      },
      databaseOptions,
    );
    const rollbackFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(bundle)));
    await expect(
      refreshRemoteModelCatalog({
        config: {},
        fetchImpl: rollbackFetch,
        databaseOptions,
        force: true,
        now: () => 20_000,
      }),
    ).resolves.toMatchObject({ status: "unchanged", generatedAt: newerBundle.generatedAt });
    expect(readRemoteModelCatalog(databaseOptions)?.generated_at).toBe(newerBundle.generatedAt);

    const mirrorBundle = { ...bundle, generatedAt: newerBundle.generatedAt + 100 };
    const mirrorFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(mirrorBundle)));
    await expect(
      refreshRemoteModelCatalog({
        config: {
          models: { catalogRefresh: { url: "https://mirror.example.test/catalog.json" } },
        },
        fetchImpl: mirrorFetch,
        databaseOptions,
        now: () => 20_001,
        bundledGeneratedAt: () => bundle.generatedAt - 1,
      }),
    ).resolves.toMatchObject({ status: "updated", generatedAt: mirrorBundle.generatedAt });
    expect(mirrorFetch).toHaveBeenCalledOnce();
  });

  it("returns typed failures for invalid JSON, newer minVersion, and timeout", async () => {
    const invalid = vi.fn<typeof fetch>(async () => new Response("not json"));
    await expect(
      refreshRemoteModelCatalog({
        config: {},
        fetchImpl: invalid,
        databaseOptions: options(),
        force: true,
      }),
    ).resolves.toMatchObject({ status: "error" });

    const newer = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ...bundle, minVersion: "9999.1.1" })),
    );
    await expect(
      refreshRemoteModelCatalog({
        config: {},
        fetchImpl: newer,
        databaseOptions: options(),
        force: true,
      }),
    ).resolves.toMatchObject({ status: "error" });

    const timeout = vi.fn<typeof fetch>(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await expect(
      refreshRemoteModelCatalog({
        config: {},
        fetchImpl: timeout,
        databaseOptions: options(),
        force: true,
      }),
    ).resolves.toMatchObject({ status: "error" });
  });

  it.each(["invalid UTF-8", "unsupported schema", "rates on unknown pricing"])(
    "preserves the previous catalog without a fallback request after %s",
    async (failure) => {
      const databaseOptions = options();
      const previous = {
        bundle_json: JSON.stringify(bundle),
        generated_at: bundle.generatedAt,
        min_version: bundle.minVersion,
        source_url: DEFAULT_REMOTE_MODEL_CATALOG_URL,
        etag: '"previous"',
        last_modified: "Wed, 23 Jul 2025 00:00:00 GMT",
        checked_at: 10_000,
      };
      writeRemoteModelCatalog(previous, databaseOptions);

      const corrupt = Buffer.from(
        JSON.stringify({
          ...bundle,
          generatedAt: bundle.generatedAt + 1,
          ...(failure === "unsupported schema" ? { schemaVersion: 3 } : {}),
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

      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(corrupt, { status: 200 }));
      await expect(
        refreshRemoteModelCatalog({
          config: {},
          fetchImpl,
          databaseOptions,
          force: true,
        }),
      ).resolves.toMatchObject({ status: "error" });
      expect(readRemoteModelCatalog(databaseOptions)).toMatchObject(previous);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );
});
