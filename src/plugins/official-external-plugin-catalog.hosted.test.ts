import "../test-utils/prepare-compiled-subprocesses.js";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  createSigningKey,
  signCatalogEnvelope,
  legacyCatalogEnvelope,
} from "./official-external-catalog-signing.test-support.js";
import * as snapshotStores from "./official-external-plugin-catalog-snapshot-store.js";
import {
  getOfficialExternalPluginCatalogManifest as manifest,
  resolveOfficialExternalPluginInstall as install,
  loadConfiguredHostedOfficialExternalPluginCatalogEntries as loadHostedCatalogImpl,
  type OfficialExternalPluginCatalogFeed,
} from "./official-external-plugin-catalog.js";
import {
  createInMemoryHostedCatalogSnapshotStore as memoryStore,
  installableEntry,
  hostedCatalogFeed as makeFeed,
} from "./official-external-plugin-catalog.test-support.js";
import type { HostedOfficialExternalPluginCatalogSnapshot } from "./official-external-plugin-catalog.types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    if (tempDirs.dirs.size > 0) {
      await closeOpenClawStateDatabaseAsync();
    }
    cleanup();
  }),
);
const realStore = snapshotStores.createSqliteHostedOfficialExternalPluginCatalogSnapshotStore;

function sqliteStore() {
  return realStore({
    stateDir: tempDirs.make("openclaw-catalog-"),
  });
}

const FEED_URL = "https://packages.acme.example/openclaw/feed";
const originalFetch = globalThis.fetch;

type LoadParams = NonNullable<Parameters<typeof loadHostedCatalogImpl>[0]> & {
  fetchImpl?: typeof globalThis.fetch;
  snapshotStore?: ReturnType<typeof memoryStore> | null;
};
type CatalogConfig = NonNullable<LoadParams["catalogConfig"]>;
type LoadResult = Awaited<ReturnType<typeof loadHostedCatalog>>;

afterEach(() => vi.unstubAllGlobals());

async function loadHostedCatalog({ fetchImpl, snapshotStore, ...params }: LoadParams = {}) {
  vi.stubGlobal("fetch", fetchImpl ?? originalFetch);
  using _ = vi
    .spyOn(snapshotStores, "createSqliteHostedOfficialExternalPluginCatalogSnapshotStore")
    .mockImplementation((options) =>
      snapshotStore === undefined ? realStore(options) : (snapshotStore ?? memoryStore()),
    );
  return await loadHostedCatalogImpl(params);
}

function expectSource<Source extends LoadResult["source"]>(
  result: LoadResult,
  source: Source,
  names?: string[],
  error?: string,
): asserts result is Extract<LoadResult, { source: Source }> {
  expect(result.source).toBe(source);
  if (names) {
    expect(result.entries.map((entry) => entry.name)).toEqual(names);
  }
  if (error) {
    expect(result).toMatchObject({ error: expect.stringContaining(error) });
  }
}

function fetchBody(body: BodyInit | null, init: ResponseInit = {}, signed = false) {
  return vi.fn(async () => (signed ? dsseResponse(body, init) : new Response(body, init)));
}

function malformedFeed(keyId?: string) {
  return signFeed({
    feed: {
      ...makeFeed({ sequence: 10, pluginName: "@openclaw/malformed-current" }),
      generatedAt: "not-a-date",
    },
    keyId,
  });
}

function signFeed(params: {
  feed: OfficialExternalPluginCatalogFeed;
  privateKeyPem?: string;
  keyId?: string;
}) {
  const key = createSigningKey(params.keyId ?? "acme-root", params.privateKeyPem);
  return {
    body: JSON.stringify(signCatalogEnvelope(params.feed, [key])),
    keyId: key.keyId,
    privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: key.publicKey.export({ type: "spki", format: "pem" }),
  };
}

function signedFeed(
  sequence: number,
  pluginName: string,
  signing: Omit<Parameters<typeof signFeed>[0], "feed"> = {},
) {
  return signFeed({ feed: makeFeed({ sequence, pluginName }), ...signing });
}

function toLegacyBetaSignedEnvelope(body: string): string {
  const envelope: ReturnType<typeof signCatalogEnvelope> = JSON.parse(body);
  return JSON.stringify(legacyCatalogEnvelope(envelope));
}

function signedCatalogConfig(publicKeyPem: string, keyId = "acme-root"): CatalogConfig {
  return {
    feeds: {
      acme: {
        url: FEED_URL,
        feedId: "openclaw-official-external-plugins",
        verification: {
          mode: "signed",
          keys: [{ keyId, publicKey: publicKeyPem }],
        },
      },
    },
    sources: {
      "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" },
    },
  };
}

function snapshot(
  body: string,
  monotonic?: { sequence: number; generatedAt: string },
  savedAt = "2026-06-22T00:00:10.000Z",
): HostedOfficialExternalPluginCatalogSnapshot {
  return {
    body,
    metadata: {
      url: FEED_URL,
      status: 200,
      checksum: `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`,
    },
    savedAt,
    trust: {
      mode: "signed",
      signedBy: "acme-root",
      signatureCount: 1,
      threshold: 1,
      verifiedAt: savedAt,
    },
    monotonic: monotonic
      ? { mode: "signed-feed", sequence: monotonic.sequence, generatedAt: monotonic.generatedAt }
      : undefined,
  };
}

function unsignedSnapshot(body: string, url = FEED_URL, savedAt?: string) {
  const value = snapshot(body, undefined, savedAt);
  delete value.trust;
  value.metadata.url = url;
  return value;
}

function dsseResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/vnd.dsse+json");
  return new Response(body, { ...init, headers });
}

function loadSigned(signed: ReturnType<typeof signFeed>, params: LoadParams = {}) {
  return loadHostedCatalog({
    feedProfile: "acme",
    catalogConfig: signedCatalogConfig(signed.publicKeyPem, signed.keyId),
    fetchImpl: fetchBody(signed.body, {}, true),
    snapshotStore: null,
    ...params,
  });
}

describe("official external plugin catalog", () => {
  it("rejects a valid default-profile envelope for a different feed identity", async () => {
    const signed = signedFeed(12, "@openclaw/replayed");

    const result = await loadHostedCatalog({
      catalogConfig: {
        feeds: {
          "clawhub-public": {
            url: "https://clawhub.ai/v1/feeds/plugins",
            feedId: "clawhub-official",
            verification: {
              mode: "signed",
              keys: [{ keyId: "acme-root", publicKey: signed.publicKeyPem }],
            },
          },
        },
      },
      fetchImpl: fetchBody(signed.body, {}, true),
      snapshotStore: null,
    });

    expectSource(
      result,
      "bundled-fallback",
      [],
      'feed id "openclaw-official-external-plugins" did not match expected "clawhub-official"',
    );
  });

  it("loads schema-v2 marketplace entries and gates installs by state and trust", async () => {
    const body = JSON.stringify({
      schemaVersion: 2,
      id: "clawhub-official",
      generatedAt: "2026-06-25T01:19:39.629Z",
      sequence: 11,
      entries: [
        {
          ...installableEntry("@acme/trusted", {
            integrity: "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
          }),
          featured: true,
        },
        { ...installableEntry("@acme/disabled"), state: "disabled" },
        {
          ...installableEntry("@acme/community"),
          publisher: { id: "acme", trust: "community" },
          openclaw: { install: { npmSpec: "@acme/community" } },
        },
        {
          type: "plugin",
          id: "@acme/missing-authority",
          openclaw: { install: { npmSpec: "@acme/missing-authority" } },
        },
      ],
    });
    const result = await loadHostedCatalog({
      fetchImpl: fetchBody(body),
      snapshotStore: sqliteStore(),
      requireSnapshotWrite: true,
    });

    expectSource(result, "hosted");
    const trusted = result.entries[0]!;
    const disabled = result.entries[1]!;
    const community = result.entries[2]!;
    const missingAuthority = result.entries[3]!;
    expect(install(trusted)).toEqual({
      clawhubSpec: "clawhub:@acme/trusted@1.2.3",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
    });
    expect(trusted.featured).toBe(true);
    expect(disabled).not.toHaveProperty("featured");
    expect(install(disabled)).toBeNull();
    expect(install(community)).toBeNull();
    expect(missingAuthority).toMatchObject({ state: "unavailable" });
    expect(manifest(missingAuthority)?.install).toBeUndefined();
    expect(install(missingAuthority)).toBeNull();
    for (const authority of [
      { publisher: { id: "acme", trust: "community" } },
      { state: "available" },
    ]) {
      expect(
        install({
          name: "@acme/incomplete",
          kind: "plugin",
          openclaw: { install: { npmSpec: "@acme/untrusted" } },
          ...authority,
        }),
      ).toBeNull();
    }
  });

  it("replaces unsigned snapshots without losing a neighboring feed", async () => {
    const snapshotStore = sqliteStore();
    const snapshotFor = (pluginName: string, url = FEED_URL) =>
      unsignedSnapshot(JSON.stringify(makeFeed({ sequence: 1, pluginName })), url);
    const first = snapshotFor("@fixture/first");
    const neighbor = snapshotFor("@fixture/neighbor", `${FEED_URL}/neighbor`);
    const replacement = snapshotFor("@fixture/replacement");

    await snapshotStore.write(first);
    await snapshotStore.write(neighbor);
    await snapshotStore.write(replacement);

    await expect(snapshotStore.read(FEED_URL)).resolves.toEqual(replacement);
    await expect(snapshotStore.read(neighbor.metadata.url)).resolves.toEqual(neighbor);
  });

  it("keeps signed SQLite snapshot writes monotonic when writes compete", async () => {
    const newer = signedFeed(10, "@openclaw/signed-v10");
    const older = signedFeed(9, "@openclaw/signed-v9", { privateKeyPem: newer.privateKeyPem });
    const snapshotStore = sqliteStore();
    const snapshotFor = (body: string, sequence: number) =>
      snapshot(body, {
        sequence,
        generatedAt: `2026-06-22T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      });

    const [newerWrite, olderWrite] = await Promise.allSettled([
      snapshotStore.write(snapshotFor(newer.body, 10)),
      snapshotStore.write(snapshotFor(older.body, 9)),
    ]);

    expect(newerWrite.status).toBe("fulfilled");
    expect(olderWrite).toMatchObject({
      status: "rejected",
      reason: { message: "hosted catalog signed feed sequence is older than current snapshot" },
    });
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: newer.body });
  });

  it("ignores an invalid recovered sequence when repairing a signed SQLite snapshot", async () => {
    const malformedBody =
      '{"schemaVersion":1,"id":"openclaw-official-external-plugins","generatedAt":"not-a-date","sequence":1e999,"entries":[]}';
    const validFeed = makeFeed({
      sequence: 10,
      pluginName: "@openclaw/repaired-sequence",
    });
    const valid = signFeed({ feed: validFeed });
    const snapshotStore = sqliteStore();

    await snapshotStore.write(snapshot(malformedBody, { sequence: 10, generatedAt: "not-a-date" }));
    await snapshotStore.write(snapshot(valid.body, validFeed));

    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: valid.body });
  });

  it("allows re-signing but retains the accepted payload on same-sequence equivocation", async () => {
    const acceptedFeed = makeFeed({
      sequence: 10,
      pluginName: "@openclaw/signed-v10",
    });
    const accepted = signFeed({ feed: acceptedFeed });
    const resigned = signFeed({ feed: acceptedFeed, keyId: "acme-rotated" });
    const conflicting = signedFeed(10, "@openclaw/conflicting-v10", {
      privateKeyPem: resigned.privateKeyPem,
      keyId: "acme-rotated",
    });
    const snapshotStore = sqliteStore();

    const initial = await loadSigned(accepted, {
      fetchImpl: vi.fn(async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("accept")).toBe("application/vnd.dsse+json");
        expect(headers.has("if-modified-since")).toBe(false);
        return dsseResponse(accepted.body);
      }),
      snapshotStore,
    });
    expectSource(initial, "hosted");
    expect(resigned.body).not.toBe(accepted.body);
    expectSource(await loadSigned(resigned, { snapshotStore }), "hosted");

    const result = await loadSigned(conflicting, { snapshotStore });

    expectSource(
      result,
      "hosted-snapshot",
      ["@openclaw/signed-v10"],
      "payload changed without a sequence increment",
    );
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: resigned.body });
  });

  it("replaces a signed snapshot with an invalid timestamp using a valid feed", async () => {
    const malformed = malformedFeed();
    const valid = signedFeed(10, "@openclaw/repaired-current", {
      privateKeyPem: malformed.privateKeyPem,
    });
    const lower = signedFeed(9, "@openclaw/lower-current", {
      privateKeyPem: malformed.privateKeyPem,
    });
    const snapshotStore = memoryStore([snapshot(malformed.body)]);

    const rejected = await loadSigned(lower, { snapshotStore });

    expectSource(rejected, "bundled-fallback");
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: malformed.body });

    const result = await loadSigned(valid, { snapshotStore });

    expectSource(result, "hosted", ["@openclaw/repaired-current"]);
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: valid.body });
  });

  it("does not replace a signed snapshot that fails current trust verification", async () => {
    const current = signedFeed(10, "@openclaw/current-key");
    const candidate = signedFeed(9, "@openclaw/new-key");
    const snapshotStore = memoryStore([snapshot(current.body)]);
    const writeSpy = vi.spyOn(snapshotStore, "write");

    const result = await loadSigned(candidate, { snapshotStore });

    expectSource(result, "bundled-fallback", undefined, "signature is invalid");
    expect(writeSpy).not.toHaveBeenCalled();
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: current.body });
  });

  it("uses accepted monotonic metadata when trusted signing keys rotate", async () => {
    const previous = signedFeed(8, "@openclaw/signed-v8", { keyId: "acme-root-2026-q2" });
    const current = signedFeed(9, "@openclaw/signed-v9", { keyId: "acme-root-2026-q3" });
    const snapshotStore = sqliteStore();

    const acceptedPrevious = await loadSigned(previous, {
      now: () => new Date("2026-06-22T00:00:08.000Z"),
      snapshotStore,
    });
    expectSource(acceptedPrevious, "hosted");

    const acceptedCurrent = await loadSigned(current, {
      now: () => new Date("2026-06-22T00:00:09.000Z"),
      snapshotStore,
    });

    expectSource(acceptedCurrent, "hosted", ["@openclaw/signed-v9"]);
    expect(acceptedCurrent.trust?.signedBy).toBe("acme-root-2026-q3");

    const rolledBack = signedFeed(7, "@openclaw/signed-v7", { keyId: "acme-root-2026-q4" });
    const rejectedRollback = await loadSigned(rolledBack, {
      now: () => new Date("2026-06-22T00:00:10.000Z"),
      snapshotStore,
    });

    expectSource(rejectedRollback, "bundled-fallback", [], "signed feed sequence is older");
    expect(rejectedRollback.error).toContain("snapshot fallback failed");

    const retainedCurrent = await loadSigned(current, { offline: true, snapshotStore });
    expectSource(retainedCurrent, "hosted-snapshot", ["@openclaw/signed-v9"]);
  });

  it("repairs malformed timestamp snapshots after trusted signing keys rotate", async () => {
    const malformed = malformedFeed("acme-root-2026-q2");
    const repairedFeed = makeFeed({
      sequence: 10,
      pluginName: "@openclaw/repaired-current",
    });
    const repaired = signFeed({
      feed: repairedFeed,
      keyId: "acme-root-2026-q3",
    });
    const snapshotStore = sqliteStore();

    await snapshotStore.write(
      snapshot(malformed.body, { sequence: 10, generatedAt: "not-a-date" }),
    );
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({
      monotonic: { mode: "signed-feed", sequence: 10 },
    });

    const result = await loadSigned(repaired, { snapshotStore });

    expectSource(result, "hosted", ["@openclaw/repaired-current"]);
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: repaired.body });
  });

  it.each(["unsigned", "beta", "wrong-media", "unsigned-override"] as const)(
    "rejects %s live signed-profile responses",
    async (kind) => {
      const signed = signedFeed(8, "@openclaw/signed");
      const body =
        kind === "beta"
          ? toLegacyBetaSignedEnvelope(signed.body)
          : kind === "wrong-media"
            ? signed.body
            : JSON.stringify(makeFeed({ sequence: 8, pluginName: "@openclaw/unsigned" }));
      const result = await loadSigned(signed, {
        fetchImpl: fetchBody(
          body,
          { headers: { "content-type": "application/json" } },
          kind !== "wrong-media",
        ),
        ...(kind === "unsigned-override" ? { feedUrl: "https://clawhub.ai/v1/feeds/plugins" } : {}),
        snapshotStore: memoryStore(),
      });
      expectSource(
        result,
        "bundled-fallback",
        [],
        kind === "wrong-media"
          ? "must use application/vnd.dsse+json"
          : "signed envelope is malformed",
      );
    },
  );

  it.each(["signed", "unsigned", "beta"] as const)(
    "re-verifies %s offline snapshots",
    async (kind) => {
      const signed = signedFeed(8, "@openclaw/signed-offline");
      const body = kind === "beta" ? toLegacyBetaSignedEnvelope(signed.body) : signed.body;
      const stored =
        kind === "unsigned"
          ? unsignedSnapshot(
              JSON.stringify(makeFeed({ sequence: 8, pluginName: "@openclaw/unsigned" })),
            )
          : snapshot(body);
      const result = await loadSigned(signed, {
        offline: true,
        snapshotStore: memoryStore([stored]),
      });
      if (kind === "unsigned") {
        expectSource(result, "bundled-fallback", undefined, "signed envelope is malformed");
      } else {
        expectSource(result, "hosted-snapshot", ["@openclaw/signed-offline"]);
      }
    },
  );

  it("rejects expired signed feeds and keeps expired snapshots visible but not installable", async () => {
    const feed = {
      ...makeFeed({
        sequence: 8,
        pluginName: "@openclaw/expiring",
        expiresAt: "2026-06-22T00:01:00.000Z",
      }),
      entries: [
        installableEntry("@openclaw/expiring", { sourceRef: "acme-npm", version: "1.0.0" }),
      ],
    } satisfies OfficialExternalPluginCatalogFeed;
    const signed = signFeed({ feed });
    const catalogConfig = signedCatalogConfig(signed.publicKeyPem);
    const snapshotStore = memoryStore();
    const seeded = await loadSigned(signed, {
      fetchImpl: fetchBody(signed.body, { headers: { etag: '"expiring"' } }, true),
      now: () => new Date("2026-06-22T00:00:30.000Z"),
      snapshotStore,
    });
    expectSource(seeded, "hosted");
    expect(install(seeded.entries[0]!, { catalogConfig })).not.toBeNull();

    const expiredFresh = await loadSigned(signed, {
      now: () => new Date("2026-06-22T00:01:01.000Z"),
    });
    expectSource(expiredFresh, "bundled-fallback", [], "signed feed expired");

    for (const scenario of [
      {
        fetchImpl: fetchBody(null, { status: 304, headers: { etag: '"expiring"' } }),
      },
      { offline: true },
      { fetchImpl: fetchBody(null, { status: 503 }) },
    ] satisfies LoadParams[]) {
      const expiredSnapshot = await loadSigned(signed, {
        now: () => new Date("2026-06-22T00:01:01.000Z"),
        snapshotStore,
        ...scenario,
      });
      expectSource(expiredSnapshot, "hosted-snapshot");
      expect(expiredSnapshot.entries).toHaveLength(1);
      expect(expiredSnapshot.entries[0]).toMatchObject({
        id: "@openclaw/expiring",
        state: "unavailable",
      });
      expect(expiredSnapshot.entries[0]?.install).toBeUndefined();
      expect(expiredSnapshot.feed.entries[0]?.install).toBeUndefined();
      expect(install(expiredSnapshot.entries[0]!, { catalogConfig })).toBeNull();
      expect(expiredSnapshot.error).toContain("signed feed expired");
    }
  });

  it.each<[string, string, string?]>([
    ["2026-06-21T23:59:59.000Z", "expiresAt must be later than generatedAt"],
    ["2026-02-30T00:00:00.000Z", "requires a valid expiresAt value"],
    [
      "2026-06-22T00:01:00.000Z",
      "expiresAt must be later than generatedAt",
      " 2026-06-22T00:02:00.000Z ",
    ],
  ])("rejects invalid signed feed expiry %s", async (expiresAt, error, generatedAt) => {
    const feed = makeFeed({
      sequence: 8,
      pluginName: "@openclaw/invalid-expiry",
      expiresAt,
    });
    if (generatedAt !== undefined) {
      feed.generatedAt = generatedAt;
    }
    const signed = signFeed({ feed });
    const result = await loadSigned(signed, { now: () => new Date("2026-06-22T00:00:30.000Z") });
    expectSource(result, "bundled-fallback", [], error);
  });

  it("uses legacy signed snapshots for rollback state without preserving install authority", async () => {
    const legacyFeed = makeFeed({ sequence: 8, pluginName: "@openclaw/legacy" });
    delete legacyFeed.expiresAt;
    const legacy = signFeed({ feed: legacyFeed });
    const newer = signedFeed(9, "@openclaw/current", { privateKeyPem: legacy.privateKeyPem });
    const snapshotStore = memoryStore([
      snapshot(legacy.body, undefined, "2026-06-22T00:00:08.000Z"),
    ]);
    const catalogConfig = signedCatalogConfig(legacy.publicKeyPem);

    const stale = await loadSigned(legacy, {
      offline: true,
      snapshotStore,
    });
    expectSource(stale, "hosted-snapshot");
    expect(stale.entries[0]).toMatchObject({ name: "@openclaw/legacy", state: "unavailable" });
    expect(install(stale.entries[0]!, { catalogConfig })).toBeNull();
    expect(stale.error).toContain("has no expiresAt");

    const updated = await loadSigned(newer, {
      now: () => new Date("2026-06-22T00:00:30.000Z"),
      snapshotStore,
    });
    expectSource(updated, "hosted", ["@openclaw/current"]);
  });

  it.each([
    [FEED_URL, "hostname is not allowed"],
    ["https://user:password@clawhub.ai/", "must not include credentials"],
    ["https://clawhub.ai/?q=value", "must not include query strings or fragments"],
    ["https://clawhub.ai/#fragment", "must not include query strings or fragments"],
  ])("rejects direct hosted feed override %s", async (feedUrl, expectedError) => {
    const fetchImpl = fetchBody("{}");
    const result = await loadHostedCatalog({ feedUrl, fetchImpl, snapshotStore: null });

    expectSource(result, "bundled-fallback", undefined, expectedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a legacy signed profile without feedId usable via a direct feed URL override", async () => {
    const signed = signedFeed(8, "@openclaw/legacy-profile");
    const catalogConfig = signedCatalogConfig(signed.publicKeyPem);
    delete catalogConfig.feeds?.acme?.feedId;

    const result = await loadSigned(signed, {
      feedUrl: "https://clawhub.ai/v1/feeds/plugins",
      catalogConfig,
    });

    expectSource(result, "hosted");
    expect(result.feed?.id).toBe("openclaw-official-external-plugins");
    expect(result.trust).toMatchObject({ mode: "signed", signedBy: "acme-root" });
  });

  it("filters every source reference and refreshes profiles between hosted loads", async () => {
    const sourceEntry = (id: string, sourceRef: string) => ({
      name: `@acme/${id}`,
      kind: "plugin",
      openclaw: { plugin: { id }, install: { sourceRef, npmSpec: `@acme/${id}` } },
    });
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "openclaw-official-external-plugins",
      generatedAt: "2026-06-22T00:00:10.000Z",
      sequence: 10,
      entries: [
        sourceEntry("known-source", "acme-npm"),
        sourceEntry("unknown-source", "attacker-npm"),
        {
          ...sourceEntry("mixed-sources", "acme-npm"),
          install: { candidates: [{ sourceRef: "acme-npm" }, { sourceRef: "attacker-npm" }] },
        },
        sourceEntry("valid-tail", "acme-npm"),
      ],
    });
    const sources: NonNullable<CatalogConfig["sources"]> = {
      "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" },
    };
    const params: LoadParams = {
      feedProfile: "acme",
      catalogConfig: {
        feeds: { acme: { url: FEED_URL } },
        sources,
      },
      fetchImpl: fetchBody(body),
      snapshotStore: null,
    };
    const result = await loadHostedCatalog(params);

    expectSource(result, "hosted", ["@acme/known-source", "@acme/valid-tail"]);
    expect(result.entries[0]).toBe(result.feed.entries[0]);

    sources["attacker-npm"] = { type: "npm" };
    const refreshed = await loadHostedCatalog(params);
    expectSource(refreshed, "hosted", [
      "@acme/known-source",
      "@acme/unknown-source",
      "@acme/mixed-sources",
      "@acme/valid-tail",
    ]);
  });

  it("enforces hosted checksum and response-size limits", async () => {
    const validBody = JSON.stringify({
      schemaVersion: 1,
      id: "clawhub-official",
      generatedAt: "2026-06-22T00:00:01.000Z",
      sequence: 1,
      entries: [],
    });
    const mismatch = await loadHostedCatalog({
      expectedSha256: "sha256:not-current",
      fetchImpl: fetchBody(validBody),
      snapshotStore: null,
    });

    expectSource(mismatch, "bundled-fallback", undefined, "checksum mismatch");
    expect(mismatch.metadata?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const oversized = await loadHostedCatalog({
      fetchImpl: fetchBody("x".repeat(1024 * 1024 + 1)),
      snapshotStore: null,
    });
    expectSource(oversized, "bundled-fallback", undefined, "exceeds 1048576 bytes");

    const response = new Response("x".repeat(8192), {
      status: 200,
      headers: { "content-length": "1" },
    });
    Object.defineProperty(response, "body", { value: null });
    const arrayBuffer = vi.fn(response.arrayBuffer.bind(response));
    Object.defineProperty(response, "arrayBuffer", { value: arrayBuffer });
    const nonStreaming = await loadHostedCatalog({
      fetchImpl: vi.fn(async () => response),
      snapshotStore: null,
    });

    expectSource(
      nonStreaming,
      "bundled-fallback",
      undefined,
      "streaming response body unavailable",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
