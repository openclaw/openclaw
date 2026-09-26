import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  remoteDecisionCost,
  remoteDecisionInference,
  remoteDecisionModel,
} from "../../packages/model-catalog-core/src/remote-catalog-bundle.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { resolveRemoteCatalogUrl } from "./remote-config.js";
import { refreshRemoteModelCatalog, REMOTE_MODEL_CATALOG_TTL_MS } from "./remote-refresh.js";
import { readRemoteModelCatalog, writeRemoteModelCatalog } from "./remote-store.js";

const roots: string[] = [];
const DEFAULT_REMOTE_MODEL_CATALOG_URL = resolveRemoteCatalogUrl({});
const bundle = {
  schemaVersion: 1,
  generatedAt: 1_753_500_000_000,
  minVersion: "2026.7.0",
  sourceCommit: "abc123",
  providers: {
    anthropic: {
      baseUrl: "https://evil.test",
      headers: { Authorization: "bad" },
      models: [{ id: "claude-test", headers: { X: "bad" } }],
    },
  },
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

  it("persists decision capabilities, billing and pricing without remote transport or authority", async () => {
    const databaseOptions = options();
    const downloaded = {
      ...bundle,
      minVersion: VERSION,
      providers: { anthropic: { ...bundle.providers.anthropic, models: [remoteDecisionModel] } },
      pricing: { "anthropic/typed": remoteDecisionCost },
    };
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(downloaded), { status: 200, headers: { etag: '"two"' } }),
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
    expect(persisted.providers.anthropic).toEqual({
      models: [
        {
          id: "typed",
          input: ["text"],
          inference: remoteDecisionInference,
          cost: remoteDecisionCost,
        },
      ],
    });
    expect(persisted.pricing).toEqual(downloaded.pricing);
  });

  it("stores a negotiated v3 feed without rewriting its version or admitting runtime authority", async () => {
    const databaseOptions = options();
    const typed = {
      schemaVersion: 3,
      generatedAt: bundle.generatedAt,
      sourceCommit: "fixture-v3",
      providers: { anthropic: {} },
      models: [
        {
          provider: "anthropic",
          id: "typed",
          inference: remoteDecisionInference,
          pricing: {
            status: "known",
            currency: "USD",
            unit: "million_tokens",
            input: 0,
            output: 0,
            source: "fixture",
          },
          compat: {
            headers: { authorization: "never-retain" },
            baseUrl: "https://never-retain.invalid",
          },
        },
      ],
    };
    const config = {
      models: { catalogRefresh: { url: "https://catalog.openclaw.ai/models/v3/catalog.json" } },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(typed));
    expect(
      await refreshRemoteModelCatalog({
        config,
        fetchImpl,
        databaseOptions,
        force: true,
        bundledGeneratedAt: () => bundle.generatedAt - 1,
      }),
    ).toMatchObject({ status: "updated", models: 1, providers: 1 });
    const previous = readRemoteModelCatalog(databaseOptions)!;
    const stored = JSON.parse(previous.bundle_json);
    expect(stored.schemaVersion).toBe(3);
    expect(stored.models[0]).toMatchObject({
      inference: remoteDecisionInference,
      pricing: { status: "known", input: 0, output: 0 },
      compat: {},
    });
    const untrusted = {
      ...typed,
      generatedAt: typed.generatedAt + 1,
      providers: { anthropic: { authScope: "plugin" } },
    };
    expect(
      await refreshRemoteModelCatalog({
        config,
        fetchImpl: async () => Response.json(untrusted),
        databaseOptions,
        force: true,
      }),
    ).toMatchObject({ status: "error" });
    expect(readRemoteModelCatalog(databaseOptions)).toMatchObject(previous);
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

  it.each(["9999.1.1", "not-a-version"])(
    "retains the stored catalog when decision metadata requires unsupported minVersion %s",
    async (minVersion) => {
      const databaseOptions = options();
      const previous = {
        bundle_json: JSON.stringify(bundle),
        generated_at: bundle.generatedAt,
        min_version: bundle.minVersion,
        source_url: DEFAULT_REMOTE_MODEL_CATALOG_URL,
        etag: '"previous"',
        last_modified: null,
        checked_at: 10_000,
      };
      writeRemoteModelCatalog(previous, databaseOptions);
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              ...bundle,
              generatedAt: bundle.generatedAt + 1,
              minVersion,
              providers: { anthropic: { models: [remoteDecisionModel] } },
            }),
          ),
      );
      await expect(
        refreshRemoteModelCatalog({
          config: {},
          fetchImpl,
          databaseOptions,
          force: true,
        }),
      ).resolves.toMatchObject({ status: "error", error: expect.stringContaining(minVersion) });
      expect(readRemoteModelCatalog(databaseOptions)).toMatchObject(previous);
    },
  );

  it("returns typed failures for invalid JSON and timeout", async () => {
    const invalid = vi.fn<typeof fetch>(async () => new Response("not json"));
    await expect(
      refreshRemoteModelCatalog({
        config: {},
        fetchImpl: invalid,
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

  it("preserves the previous catalog when a newer bundle contains invalid UTF-8", async () => {
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

    const corrupt = Buffer.from(JSON.stringify({ ...bundle, generatedAt: bundle.generatedAt + 1 }));
    const modelIdOffset = corrupt.indexOf("claude-test");
    expect(modelIdOffset).toBeGreaterThanOrEqual(0);
    corrupt[modelIdOffset + "claude-".length] = 0xff;

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
  });
});
