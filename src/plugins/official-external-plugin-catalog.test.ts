import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { createSqliteHostedOfficialExternalPluginCatalogSnapshotStore } from "./official-external-plugin-catalog-snapshot-store.js";
import {
  getOfficialExternalChannelSecretContract,
  type OfficialExternalPluginCatalogEntry,
  type OfficialExternalPluginCatalogFeed,
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntryForPackage,
  getOfficialExternalPluginCatalogManifest,
  isExternallyDistributedPlugin,
  isOfficialExternalPluginId,
  isOfficialExternalPluginCatalogFeed,
  listOfficialExternalChannelEnvVars,
  loadConfiguredHostedOfficialExternalPluginCatalogEntries as loadHostedCatalog,
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLegacyIds,
  resolveOfficialExternalPluginLegacyNpmPackageNames,
} from "./official-external-plugin-catalog.js";
import { createInMemoryHostedCatalogSnapshotStore } from "./official-external-plugin-catalog.test-support.js";
import type {
  HostedOfficialExternalPluginCatalogSnapshot,
  OfficialExternalPluginCatalogInstallCandidate,
} from "./official-external-plugin-catalog.types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    if (tempDirs.dirs.size > 0) {
      await closeOpenClawStateDatabaseAsync();
    }
    cleanup();
  }),
);

function sqliteSnapshotStore() {
  return createSqliteHostedOfficialExternalPluginCatalogSnapshotStore({
    stateDir: tempDirs.make("openclaw-catalog-"),
  });
}

function installableEntry(
  id: string,
  candidate: OfficialExternalPluginCatalogInstallCandidate = {},
): OfficialExternalPluginCatalogEntry {
  return {
    type: "plugin",
    id,
    state: "available",
    publisher: { id: "acme", trust: "official" },
    install: {
      candidates: [{ sourceRef: "public-clawhub", package: id, version: "1.2.3", ...candidate }],
    },
  };
}

const FEED_URL = "https://packages.acme.example/openclaw/feed";
const HOSTED_CATALOG_PAYLOAD_TYPE = "openclaw.official-external-plugin-catalog-feed.v1";

type HostedCatalogLoadParams = NonNullable<Parameters<typeof loadHostedCatalog>[0]>;
type HostedCatalogConfig = NonNullable<HostedCatalogLoadParams["catalogConfig"]>;
type HostedCatalogLoadResult = Awaited<ReturnType<typeof loadHostedCatalog>>;

function expectSource<Source extends HostedCatalogLoadResult["source"]>(
  result: HostedCatalogLoadResult,
  source: Source,
): asserts result is Extract<HostedCatalogLoadResult, { source: Source }> {
  expect(result.source).toBe(source);
}

function hostedCatalogFeed(params: {
  sequence: number;
  pluginName: string;
  expiresAt?: string;
}): OfficialExternalPluginCatalogFeed {
  const pluginId = params.pluginName.replace(/^@[^/]+\//u, "");
  return {
    schemaVersion: 1,
    id: "openclaw-official-external-plugins",
    generatedAt: `2026-06-22T00:00:${String(params.sequence).padStart(2, "0")}.000Z`,
    expiresAt: params.expiresAt ?? "2099-01-01T00:00:00.000Z",
    sequence: params.sequence,
    entries: [
      {
        name: params.pluginName,
        kind: "plugin",
        openclaw: {
          plugin: { id: pluginId },
          install: { sourceRef: "acme-npm", npmSpec: params.pluginName },
        },
      },
    ],
  };
}

function signedHostedCatalogFeed(params: {
  feed: OfficialExternalPluginCatalogFeed;
  privateKeyPem?: string;
  keyId?: string;
}): { body: string; privateKeyPem: string; publicKeyPem: string } {
  const privateKeyPem =
    params.privateKeyPem ??
    crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = crypto
    .createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" });
  const payloadBytes = Buffer.from(JSON.stringify(params.feed), "utf8");
  const payloadTypeBytes = Buffer.from(HOSTED_CATALOG_PAYLOAD_TYPE, "utf8");
  const signingInput = Buffer.concat([
    Buffer.from(
      `DSSEv1 ${payloadTypeBytes.length} ${HOSTED_CATALOG_PAYLOAD_TYPE} ${payloadBytes.length} `,
      "utf8",
    ),
    payloadBytes,
  ]);
  return {
    body: JSON.stringify({
      payloadType: HOSTED_CATALOG_PAYLOAD_TYPE,
      payload: payloadBytes.toString("base64url"),
      signatures: [
        {
          keyid: params.keyId ?? "acme-root",
          sig: crypto
            .sign(null, signingInput, crypto.createPrivateKey(privateKeyPem))
            .toString("base64url"),
        },
      ],
    }),
    privateKeyPem,
    publicKeyPem,
  };
}

function signedFeed(
  sequence: number,
  pluginName: string,
  signing: Omit<Parameters<typeof signedHostedCatalogFeed>[0], "feed"> = {},
) {
  return signedHostedCatalogFeed({ feed: hostedCatalogFeed({ sequence, pluginName }), ...signing });
}

function toLegacyBetaSignedEnvelope(body: string): string {
  const envelope = JSON.parse(body) as {
    payloadType: string;
    payload: string;
    signatures: Array<{ keyid: string; sig: string }>;
  };
  return JSON.stringify({
    payloadType: envelope.payloadType,
    payload: envelope.payload,
    schemaVersion: 1,
    signatures: envelope.signatures.map((signature) => ({
      keyId: signature.keyid,
      algorithm: "ed25519",
      signature: signature.sig,
    })),
  });
}

function signedCatalogConfig(publicKeyPem: string, keyId = "acme-root"): HostedCatalogConfig {
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

function signedHostedCatalogSnapshot(params: {
  body: string;
  savedAt?: string;
  monotonic?: { sequence: number; generatedAt: string };
}): HostedOfficialExternalPluginCatalogSnapshot {
  const savedAt = params.savedAt ?? "2026-06-22T00:00:10.000Z";
  return {
    body: params.body,
    metadata: {
      url: FEED_URL,
      status: 200,
      checksum: `sha256:${crypto.createHash("sha256").update(params.body).digest("hex")}`,
    },
    savedAt,
    trust: {
      mode: "signed",
      signedBy: "acme-root",
      signatureCount: 1,
      threshold: 1,
      verifiedAt: savedAt,
    },
    monotonic: params.monotonic ? { mode: "signed-feed", ...params.monotonic } : undefined,
  };
}

function dsseResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/vnd.dsse+json");
  return new Response(body, { ...init, headers });
}

function loadSigned(
  signed: ReturnType<typeof signedHostedCatalogFeed>,
  params: HostedCatalogLoadParams = {},
) {
  return loadHostedCatalog({
    feedProfile: "acme",
    catalogConfig: signedCatalogConfig(signed.publicKeyPem),
    fetchImpl: vi.fn(async () => dsseResponse(signed.body, { status: 200 })),
    snapshotStore: null,
    ...params,
  });
}

describe("official external plugin catalog", () => {
  it.each([
    { pluginId: "google-meet", packageName: "@openclaw/google-meet", external: true },
    {
      pluginId: "google-meet",
      packageName: "@openclaw/google-meet",
      packageBuild: { bundledDist: true },
      external: false,
    },
    { pluginId: "google-meet", packageName: "@example/google-meet", external: false },
    { pluginId: "other-plugin", packageName: "@openclaw/google-meet", external: false },
    {
      pluginId: "source-external",
      packageName: "@example/source-external",
      packageBuild: { bundledDist: false },
      external: true,
    },
  ])(
    "classifies distribution ownership for $pluginId from $packageName",
    ({ external, ...plugin }) => {
      expect(isExternallyDistributedPlugin(plugin)).toBe(external);
    },
  );

  it("keeps Fish Audio's legacy id migration-only across npm and ClawHub routes", () => {
    const entry = getOfficialExternalPluginCatalogEntryForPackage("@openclaw/fish-audio-speech");
    expect(entry).toBeDefined();
    expect(resolveOfficialExternalPluginId(entry!)).toBe("fish-audio-speech");
    expect(resolveOfficialExternalPluginLegacyIds(entry!)).toEqual(["fish-audio"]);
    expect(resolveOfficialExternalPluginInstall(entry!)).toEqual({
      clawhubSpec: "clawhub:@openclaw/fish-audio-speech",
      npmSpec: "@openclaw/fish-audio-speech",
      defaultChoice: "npm",
      minHostVersion: ">=2026.7.2",
    });
    expect(getOfficialExternalPluginCatalogEntry("fish-audio-speech")).toBe(entry);
    expect(getOfficialExternalPluginCatalogEntry("fish-audio")).toBeUndefined();
    expect(isOfficialExternalPluginId("fish-audio-speech")).toBe(true);
    expect(isOfficialExternalPluginId("fish-audio")).toBe(false);
  });

  it("does not allow malformed feed wrappers to count as feed documents", () => {
    const feed = hostedCatalogFeed({ sequence: 1, pluginName: "@acme/plugin" });
    feed.generatedAt = " 2026-06-22 00:00:10Z ";
    expect(isOfficialExternalPluginCatalogFeed({ ...feed, schemaVersion: 2 })).toBe(true);
    for (const invalid of [
      { id: " " },
      { schemaVersion: 3 },
      { generatedAt: "not-a-date" },
      { generatedAt: "2026-02-30T00:00:00.000Z" },
      { sequence: Number.POSITIVE_INFINITY },
    ]) {
      expect(isOfficialExternalPluginCatalogFeed({ ...feed, ...invalid })).toBe(false);
    }
  });

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
      fetchImpl: vi.fn(async () => dsseResponse(signed.body, { status: 200 })),
      snapshotStore: null,
    });

    expectSource(result, "bundled-fallback");
    expect(result.entries).toEqual([]);
    expect(result.error).toContain(
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
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      snapshotStore: sqliteSnapshotStore(),
      requireSnapshotWrite: true,
    });

    expectSource(result, "hosted");
    expect(result.entries.map((entry) => entry.id)).toEqual([
      "@acme/trusted",
      "@acme/disabled",
      "@acme/community",
      "@acme/missing-authority",
    ]);
    const [trusted, disabled, community, missingAuthority] = result.entries;
    if (!trusted || !disabled || !community || !missingAuthority) {
      throw new Error("expected schema-v2 marketplace entries");
    }
    expect(resolveOfficialExternalPluginInstall(trusted)).toEqual({
      clawhubSpec: "clawhub:@acme/trusted@1.2.3",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
    });
    expect(trusted.featured).toBe(true);
    expect(disabled).not.toHaveProperty("featured");
    expect(resolveOfficialExternalPluginInstall(disabled)).toBeNull();
    expect(resolveOfficialExternalPluginInstall(community)).toBeNull();
    expect(missingAuthority).toMatchObject({ state: "unavailable" });
    expect(getOfficialExternalPluginCatalogManifest(missingAuthority)?.install).toBeUndefined();
    expect(resolveOfficialExternalPluginInstall(missingAuthority)).toBeNull();
    for (const authority of [
      { publisher: { id: "acme", trust: "community" } },
      { state: "available" },
    ]) {
      expect(
        resolveOfficialExternalPluginInstall({
          name: "@acme/incomplete",
          kind: "plugin",
          openclaw: { install: { npmSpec: "@acme/untrusted" } },
          ...authority,
        }),
      ).toBeNull();
    }
  });

  it("keeps signed SQLite snapshot writes monotonic when writes compete", async () => {
    const newer = signedFeed(10, "@openclaw/signed-v10");
    const older = signedFeed(9, "@openclaw/signed-v9", { privateKeyPem: newer.privateKeyPem });
    const snapshotStore = sqliteSnapshotStore();
    const snapshotFor = (body: string, sequence: number) =>
      signedHostedCatalogSnapshot({
        body,
        monotonic: {
          sequence,
          generatedAt: `2026-06-22T00:00:${String(sequence).padStart(2, "0")}.000Z`,
        },
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
    const validFeed = hostedCatalogFeed({
      sequence: 10,
      pluginName: "@openclaw/repaired-sequence",
    });
    const valid = signedHostedCatalogFeed({ feed: validFeed });
    const snapshotStore = sqliteSnapshotStore();

    await snapshotStore.write(
      signedHostedCatalogSnapshot({
        body: malformedBody,
        monotonic: { sequence: 10, generatedAt: "not-a-date" },
      }),
    );
    await snapshotStore.write(
      signedHostedCatalogSnapshot({
        body: valid.body,
        monotonic: {
          sequence: validFeed.sequence,
          generatedAt: validFeed.generatedAt,
        },
      }),
    );

    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: valid.body });
  });

  it("allows re-signing but retains the accepted payload on same-sequence equivocation", async () => {
    const acceptedFeed = hostedCatalogFeed({
      sequence: 10,
      pluginName: "@openclaw/signed-v10",
    });
    const accepted = signedHostedCatalogFeed({ feed: acceptedFeed });
    const resigned = signedHostedCatalogFeed({ feed: acceptedFeed, keyId: "acme-rotated" });
    const conflicting = signedFeed(10, "@openclaw/conflicting-v10", {
      privateKeyPem: resigned.privateKeyPem,
      keyId: "acme-rotated",
    });
    const snapshotStore = sqliteSnapshotStore();
    const catalogConfig = signedCatalogConfig(resigned.publicKeyPem, "acme-rotated");

    const initial = await loadSigned(accepted, {
      ifModifiedSince: "Mon, 22 Jun 2026 00:00:00 GMT",
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
    expectSource(await loadSigned(resigned, { catalogConfig, snapshotStore }), "hosted");

    const result = await loadSigned(conflicting, {
      catalogConfig,
      snapshotStore,
    });

    expectSource(result, "hosted-snapshot");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/signed-v10"]);
    expect(result.error).toContain("payload changed without a sequence increment");
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: resigned.body });
  });

  it("replaces a signed snapshot with an invalid timestamp using a valid feed", async () => {
    const malformed = signedHostedCatalogFeed({
      feed: {
        ...hostedCatalogFeed({ sequence: 10, pluginName: "@openclaw/malformed-current" }),
        generatedAt: "not-a-date",
      },
    });
    const valid = signedFeed(10, "@openclaw/repaired-current", {
      privateKeyPem: malformed.privateKeyPem,
    });
    const lower = signedFeed(9, "@openclaw/lower-current", {
      privateKeyPem: malformed.privateKeyPem,
    });
    const snapshotStore = createInMemoryHostedCatalogSnapshotStore([
      signedHostedCatalogSnapshot({ body: malformed.body }),
    ]);

    const rejected = await loadSigned(lower, { snapshotStore });

    expectSource(rejected, "bundled-fallback");
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: malformed.body });

    const result = await loadSigned(valid, { snapshotStore });

    expectSource(result, "hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/repaired-current"]);
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: valid.body });
  });

  it("does not replace a signed snapshot that fails current trust verification", async () => {
    const current = signedFeed(10, "@openclaw/current-key");
    const candidate = signedFeed(9, "@openclaw/new-key");
    const snapshotStore = createInMemoryHostedCatalogSnapshotStore([
      signedHostedCatalogSnapshot({ body: current.body }),
    ]);
    const writeSpy = vi.spyOn(snapshotStore, "write");

    const result = await loadSigned(candidate, { snapshotStore });

    expectSource(result, "bundled-fallback");
    expect(result.error).toContain("signature is invalid");
    expect(writeSpy).not.toHaveBeenCalled();
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: current.body });
  });

  it("uses accepted monotonic metadata when trusted signing keys rotate", async () => {
    const previous = signedFeed(8, "@openclaw/signed-v8", { keyId: "acme-root-2026-q2" });
    const current = signedFeed(9, "@openclaw/signed-v9", { keyId: "acme-root-2026-q3" });
    const snapshotStore = sqliteSnapshotStore();

    const acceptedPrevious = await loadSigned(previous, {
      catalogConfig: signedCatalogConfig(previous.publicKeyPem, "acme-root-2026-q2"),
      now: () => new Date("2026-06-22T00:00:08.000Z"),
      snapshotStore,
    });
    expectSource(acceptedPrevious, "hosted");

    const acceptedCurrent = await loadSigned(current, {
      catalogConfig: signedCatalogConfig(current.publicKeyPem, "acme-root-2026-q3"),
      now: () => new Date("2026-06-22T00:00:09.000Z"),
      snapshotStore,
    });

    expect(acceptedCurrent.source, JSON.stringify(acceptedCurrent)).toBe("hosted");
    expect(acceptedCurrent.entries.map((entry) => entry.name)).toEqual(["@openclaw/signed-v9"]);
    if (acceptedCurrent.source === "hosted") {
      expect(acceptedCurrent.trust?.signedBy).toBe("acme-root-2026-q3");
    }

    const rolledBack = signedFeed(7, "@openclaw/signed-v7", { keyId: "acme-root-2026-q4" });
    const rejectedRollback = await loadSigned(rolledBack, {
      catalogConfig: signedCatalogConfig(rolledBack.publicKeyPem, "acme-root-2026-q4"),
      now: () => new Date("2026-06-22T00:00:10.000Z"),
      snapshotStore,
    });

    expectSource(rejectedRollback, "bundled-fallback");
    expect(rejectedRollback.entries).toEqual([]);
    expect(rejectedRollback.error).toContain("signed feed sequence is older");
    expect(rejectedRollback.error).toContain("snapshot fallback failed");

    const retainedCurrent = await loadHostedCatalog({
      feedProfile: "acme",
      catalogConfig: signedCatalogConfig(current.publicKeyPem, "acme-root-2026-q3"),
      offline: true,
      snapshotStore,
    });
    expectSource(retainedCurrent, "hosted-snapshot");
    expect(retainedCurrent.entries.map((entry) => entry.name)).toEqual(["@openclaw/signed-v9"]);
  });

  it("repairs malformed timestamp snapshots after trusted signing keys rotate", async () => {
    const malformed = signedHostedCatalogFeed({
      feed: {
        ...hostedCatalogFeed({ sequence: 10, pluginName: "@openclaw/malformed-current" }),
        generatedAt: "not-a-date",
      },
      keyId: "acme-root-2026-q2",
    });
    const repairedFeed = hostedCatalogFeed({
      sequence: 10,
      pluginName: "@openclaw/repaired-current",
    });
    const repaired = signedHostedCatalogFeed({
      feed: repairedFeed,
      keyId: "acme-root-2026-q3",
    });
    const snapshotStore = sqliteSnapshotStore();

    await snapshotStore.write(
      signedHostedCatalogSnapshot({
        body: malformed.body,
        monotonic: { sequence: 10, generatedAt: "not-a-date" },
      }),
    );
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({
      monotonic: { mode: "signed-feed", sequence: 10 },
    });

    const result = await loadSigned(repaired, {
      catalogConfig: signedCatalogConfig(repaired.publicKeyPem, "acme-root-2026-q3"),
      snapshotStore,
    });

    expect(result.source, JSON.stringify(result)).toBe("hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual(["@openclaw/repaired-current"]);
    await expect(snapshotStore.read(FEED_URL)).resolves.toMatchObject({ body: repaired.body });
  });

  it("fails closed for unsigned signed-profile responses and re-verifies offline snapshots", async () => {
    const signed = signedFeed(8, "@openclaw/signed-offline");
    const unsignedBody = JSON.stringify(
      hostedCatalogFeed({ sequence: 8, pluginName: "@openclaw/unsigned" }),
    );

    const unsigned = await loadSigned(signed, {
      fetchImpl: vi.fn(async () => dsseResponse(unsignedBody, { status: 200 })),
      snapshotStore: createInMemoryHostedCatalogSnapshotStore(),
    });

    expectSource(unsigned, "bundled-fallback");
    expect(unsigned.entries).toEqual([]);
    expect(unsigned.error).toContain("signed envelope is malformed");

    const signedSnapshot = createInMemoryHostedCatalogSnapshotStore([
      signedHostedCatalogSnapshot({
        body: signed.body,
        savedAt: "2026-06-22T00:00:08.000Z",
      }),
    ]);
    const offline = await loadSigned(signed, {
      offline: true,
      snapshotStore: signedSnapshot,
    });

    expectSource(offline, "hosted-snapshot");
    expect(offline.entries.map((entry) => entry.name)).toEqual(["@openclaw/signed-offline"]);

    const unsignedSnapshot = createInMemoryHostedCatalogSnapshotStore([
      {
        body: unsignedBody,
        metadata: {
          url: FEED_URL,
          status: 200,
          checksum: `sha256:${crypto.createHash("sha256").update(unsignedBody).digest("hex")}`,
        },
        savedAt: "2026-06-22T00:00:08.000Z",
      },
    ]);
    const rejectedSnapshot = await loadSigned(signed, {
      offline: true,
      snapshotStore: unsignedSnapshot,
    });

    expectSource(rejectedSnapshot, "bundled-fallback");
    expect(rejectedSnapshot.error).toContain("signed envelope is malformed");
  });

  it("accepts beta envelopes only from persisted snapshots", async () => {
    const signed = signedFeed(8, "@openclaw/legacy-snapshot");
    const legacyBody = toLegacyBetaSignedEnvelope(signed.body);

    const live = await loadSigned(signed, {
      fetchImpl: vi.fn(async () => dsseResponse(legacyBody, { status: 200 })),
      snapshotStore: null,
    });

    expectSource(live, "bundled-fallback");
    expect(live.error).toContain("signed envelope is malformed");

    const offline = await loadSigned(signed, {
      offline: true,
      snapshotStore: createInMemoryHostedCatalogSnapshotStore([
        signedHostedCatalogSnapshot({ body: legacyBody }),
      ]),
    });

    expectSource(offline, "hosted-snapshot");
    expect(offline.entries.map((entry) => entry.name)).toEqual(["@openclaw/legacy-snapshot"]);
  });

  it("fails closed when a signed feed response does not use the DSSE media type", async () => {
    const signed = signedFeed(8, "@openclaw/wrong-media-type");
    const result = await loadSigned(signed, {
      fetchImpl: vi.fn(
        async () =>
          new Response(signed.body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      snapshotStore: createInMemoryHostedCatalogSnapshotStore(),
    });

    expectSource(result, "bundled-fallback");
    expect(result.entries).toEqual([]);
    expect(result.error).toContain("must use application/vnd.dsse+json");
  });

  it("rejects expired signed feeds and keeps expired snapshots visible but not installable", async () => {
    const feed = {
      ...hostedCatalogFeed({
        sequence: 8,
        pluginName: "@openclaw/expiring",
        expiresAt: "2026-06-22T00:01:00.000Z",
      }),
      entries: [
        installableEntry("@openclaw/expiring", { sourceRef: "acme-npm", version: "1.0.0" }),
      ],
    } satisfies OfficialExternalPluginCatalogFeed;
    const signed = signedHostedCatalogFeed({ feed });
    const catalogConfig = signedCatalogConfig(signed.publicKeyPem);
    const snapshotStore = createInMemoryHostedCatalogSnapshotStore();
    const seeded = await loadHostedCatalog({
      feedProfile: "acme",
      catalogConfig,
      fetchImpl: vi.fn(async () =>
        dsseResponse(signed.body, { status: 200, headers: { etag: '"expiring"' } }),
      ),
      now: () => new Date("2026-06-22T00:00:30.000Z"),
      snapshotStore,
    });
    expectSource(seeded, "hosted");
    expect(
      resolveOfficialExternalPluginInstall(seeded.entries[0]!, { catalogConfig }),
    ).not.toBeNull();

    const expiredFresh = await loadSigned(signed, {
      catalogConfig,
      now: () => new Date("2026-06-22T00:01:01.000Z"),
      snapshotStore: null,
    });
    expectSource(expiredFresh, "bundled-fallback");
    expect(expiredFresh.entries).toEqual([]);
    expect(expiredFresh.error).toContain("signed feed expired");

    for (const scenario of [
      {
        ifNoneMatch: '"expiring"',
        fetchImpl: vi.fn(
          async () => new Response(null, { status: 304, headers: { etag: '"expiring"' } }),
        ),
      },
      { offline: true },
      { fetchImpl: vi.fn(async () => new Response(null, { status: 503 })) },
    ] satisfies HostedCatalogLoadParams[]) {
      const expiredSnapshot = await loadHostedCatalog({
        feedProfile: "acme",
        catalogConfig,
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
      expect(
        resolveOfficialExternalPluginInstall(expiredSnapshot.entries[0]!, { catalogConfig }),
      ).toBeNull();
      expect(expiredSnapshot.error).toContain("signed feed expired");
    }
  });

  it.each([
    ["2026-06-21T23:59:59.000Z", "expiresAt must be later than generatedAt"],
    ["2026-02-30T00:00:00.000Z", "requires a valid expiresAt value"],
  ])("rejects invalid signed feed expiry %s", async (expiresAt, error) => {
    const signed = signedHostedCatalogFeed({
      feed: hostedCatalogFeed({ sequence: 8, pluginName: "@openclaw/invalid-expiry", expiresAt }),
    });
    const result = await loadSigned(signed, { now: () => new Date("2026-06-22T00:00:30.000Z") });
    expectSource(result, "bundled-fallback");
    expect(result.entries).toEqual([]);
    expect(result.error).toContain(error);
  });

  it("uses legacy signed snapshots for rollback state without preserving install authority", async () => {
    const legacyFeed = hostedCatalogFeed({ sequence: 8, pluginName: "@openclaw/legacy" });
    delete legacyFeed.expiresAt;
    const legacy = signedHostedCatalogFeed({ feed: legacyFeed });
    const newer = signedFeed(9, "@openclaw/current", { privateKeyPem: legacy.privateKeyPem });
    const snapshotStore = createInMemoryHostedCatalogSnapshotStore([
      signedHostedCatalogSnapshot({ body: legacy.body, savedAt: "2026-06-22T00:00:08.000Z" }),
    ]);
    const catalogConfig = signedCatalogConfig(legacy.publicKeyPem);

    const stale = await loadSigned(legacy, {
      offline: true,
      snapshotStore,
    });
    expectSource(stale, "hosted-snapshot");
    expect(stale.entries[0]).toMatchObject({ name: "@openclaw/legacy", state: "unavailable" });
    expect(resolveOfficialExternalPluginInstall(stale.entries[0]!, { catalogConfig })).toBeNull();
    expect(stale.error).toContain("has no expiresAt");

    const updated = await loadSigned(newer, {
      catalogConfig,
      now: () => new Date("2026-06-22T00:00:30.000Z"),
      snapshotStore,
    });
    expectSource(updated, "hosted");
    expect(updated.entries.map((entry) => entry.name)).toEqual(["@openclaw/current"]);
  });

  it.each([
    ["off-allowlist hosts", FEED_URL, "hostname is not allowed"],
    [
      "credential-bearing URLs",
      "https://user:test-auth-token@clawhub.ai/v1/feeds/plugins",
      "must not include credentials",
    ],
    [
      "query-bearing URLs",
      "https://clawhub.ai/v1/feeds/plugins?query=test-value",
      "must not include query strings or fragments",
    ],
    [
      "fragment-bearing URLs",
      "https://clawhub.ai/v1/feeds/plugins#fragment",
      "must not include query strings or fragments",
    ],
  ])("rejects direct hosted feed overrides with %s", async (_label, feedUrl, expectedError) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await loadHostedCatalog({ feedUrl, fetchImpl, snapshotStore: null });

    expectSource(result, "bundled-fallback");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.error).toContain(expectedError);
  });

  it("keeps a legacy signed profile without feedId usable via a direct feed URL override", async () => {
    const signed = signedFeed(8, "@openclaw/legacy-profile");
    const catalogConfig = signedCatalogConfig(signed.publicKeyPem);
    delete catalogConfig.feeds?.acme?.feedId;

    const result = await loadHostedCatalog({
      feedProfile: "acme",
      feedUrl: "https://clawhub.ai/v1/feeds/plugins",
      catalogConfig,
      fetchImpl: vi.fn(async () => dsseResponse(signed.body, { status: 200 })),
      snapshotStore: null,
    });

    expectSource(result, "hosted");
    expect(result.feed?.id).toBe("openclaw-official-external-plugins");
    expect(result.trust).toMatchObject({ mode: "signed", signedBy: "acme-root" });
  });

  it("preserves signed profile verification for direct feed URL overrides", async () => {
    const signed = signedFeed(8, "@openclaw/signed-override");
    const unsignedBody = JSON.stringify(
      hostedCatalogFeed({ sequence: 8, pluginName: "@openclaw/unsigned-override" }),
    );
    const result = await loadSigned(signed, {
      feedUrl: "https://clawhub.ai/v1/feeds/plugins",
      fetchImpl: vi.fn(async () => dsseResponse(unsignedBody, { status: 200 })),
      snapshotStore: null,
    });

    expectSource(result, "bundled-fallback");
    expect(result.error).toContain("signed envelope is malformed");
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
    const sources: NonNullable<HostedCatalogConfig["sources"]> = {
      "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" },
    };
    const params: HostedCatalogLoadParams = {
      feedProfile: "acme",
      catalogConfig: {
        feeds: { acme: { url: FEED_URL } },
        sources,
      },
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      snapshotStore: null,
    };
    const result = await loadHostedCatalog(params);

    expectSource(result, "hosted");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "@acme/known-source",
      "@acme/valid-tail",
    ]);
    expect(result.entries[0]).toBe(result.feed.entries[0]);

    sources["attacker-npm"] = { type: "npm" };
    const refreshed = await loadHostedCatalog(params);
    expectSource(refreshed, "hosted");
    expect(refreshed.entries.map((entry) => entry.name)).toEqual([
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
      fetchImpl: vi.fn(async () => new Response(validBody, { status: 200 })),
      snapshotStore: null,
    });

    expectSource(mismatch, "bundled-fallback");
    expect(mismatch.error).toContain("checksum mismatch");
    expect(mismatch.metadata?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const oversized = await loadHostedCatalog({
      maxBytes: 4,
      fetchImpl: vi.fn(async () => new Response("12345", { status: 200 })),
      snapshotStore: null,
    });
    expectSource(oversized, "bundled-fallback");
    expect(oversized.error).toContain("exceeds 4 bytes");

    const response = new Response("x".repeat(8192), {
      status: 200,
      headers: { "content-length": "1" },
    });
    Object.defineProperty(response, "body", { value: null });
    const arrayBuffer = vi.fn(response.arrayBuffer.bind(response));
    Object.defineProperty(response, "arrayBuffer", { value: arrayBuffer });
    const nonStreaming = await loadHostedCatalog({
      maxBytes: 4096,
      fetchImpl: vi.fn(async () => response),
      snapshotStore: null,
    });

    expectSource(nonStreaming, "bundled-fallback");
    expect(nonStreaming.error).toContain("streaming response body unavailable");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("prefers feed install candidates before legacy install metadata", () => {
    expect(
      resolveOfficialExternalPluginInstall({
        ...installableEntry("@openclaw/candidate-package", {
          integrity: "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
        }),
        name: "@legacy/plain-package",
        openclaw: {
          plugin: { id: "candidate-package" },
          install: {
            npmSpec: "@legacy/plain-package",
            minHostVersion: ">=2026.6.1",
            expectedIntegrity: "sha256:manifest",
            allowInvalidConfigRecovery: true,
          },
        },
      }),
    ).toEqual({
      clawhubSpec: "clawhub:@openclaw/candidate-package@1.2.3",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
      minHostVersion: ">=2026.6.1",
      allowInvalidConfigRecovery: true,
    });
    for (const [integrity, expected] of [
      [undefined, { npmSpec: "@acme/private@4.5.6", defaultChoice: "npm" }],
      [
        "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
        { npmSpec: "@acme/private@4.5.6", defaultChoice: "npm" },
      ],
      [
        "sha512-abc=",
        { npmSpec: "@acme/private@4.5.6", defaultChoice: "npm", expectedIntegrity: "sha512-abc=" },
      ],
    ] as const) {
      expect(
        resolveOfficialExternalPluginInstall(
          installableEntry("@acme/private", { sourceRef: "acme-npm", version: "4.5.6", integrity }),
          { catalogConfig: { sources: { "acme-npm": { type: "npm" } } } },
        ),
      ).toEqual(expected);
    }
    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "git-only-package",
          kind: "plugin",
          install: {
            candidates: [{ sourceRef: "acme-git", package: "git@example.com:acme/plugin.git" }],
          },
        },
        { catalogConfig: { sources: { "acme-git": { type: "git" } } } },
      ),
    ).toBeNull();
    expect(
      resolveOfficialExternalPluginInstall({ id: "metadata-only", title: "Metadata only" }),
    ).toBeNull();
  });

  it("resolves channel aliases and legacy packages to their published owner", () => {
    const entry = getOfficialExternalPluginCatalogEntry("qqbot");
    if (!entry) {
      throw new Error("Expected catalog entry for qqbot");
    }
    expect(getOfficialExternalPluginCatalogEntry("openclaw-qqbot")).toBe(entry);
    expect(resolveOfficialExternalPluginId(entry)).toBe("openclaw-qqbot");
    expect(resolveOfficialExternalPluginLegacyNpmPackageNames(entry)).toEqual(["@openclaw/qqbot"]);
    expect(resolveOfficialExternalPluginInstall(entry)).toEqual({
      npmSpec: "@tencent-connect/openclaw-qqbot@2.0.3",
      defaultChoice: "npm",
      expectedIntegrity:
        "sha512-yngu/2cPeZjJfIfHWCXWB2/6KlDHrb9vpOUjKLdQxePLSp6wCn3CFOALcBIVq/9o6jlYz9WTU9idW6nfX1xpFA==",
    });
    expect(getOfficialExternalChannelSecretContract("qqbot")).toEqual({
      channelId: "qqbot",
      fields: [{ field: "clientSecret", activationField: "appId", activationEnv: "QQBOT_APP_ID" }],
    });
  });

  it("projects channel environment variables from generated configured-state metadata", () => {
    const envVarsByChannel = new Map(
      listOfficialExternalChannelEnvVars().map((entry) => [entry.channelId, entry.envVars]),
    );

    expect(envVarsByChannel.get("clickclack")).toEqual(["CLICKCLACK_BOT_TOKEN"]);
    expect(envVarsByChannel.get("mattermost")).toEqual(["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]);
  });

  it("maps capability provider ids to plugin owners", () => {
    expect(
      resolveOfficialExternalProviderContractPluginIds({
        contract: "speechProviders",
        providerIds: new Set(["gradium", "inworld", "xiaomi"]),
      }),
    ).toEqual(["gradium", "inworld", "xiaomi"]);
  });

  it("maps env-only web-fetch credentials to external plugin owners", () => {
    expect(
      resolveOfficialExternalWebProviderContractPluginIdsForEnv({
        contract: "webFetchProviders",
        env: { FIRECRAWL_API_KEY: "firecrawl-key" },
      }),
    ).toEqual(["firecrawl"]);
    expect(
      resolveOfficialExternalWebProviderContractPluginIdsForEnv({
        contract: "webFetchProviders",
        env: { EXA_API_KEY: "exa-key" },
      }),
    ).toEqual([]);
  });

  it("maps configured provider ids and aliases even without an auth choice", () => {
    expect(
      resolveOfficialExternalProviderPluginIds({
        providerIds: new Set(["groq", "modelstudio"]),
      }),
    ).toEqual(["groq", "qwen"]);
  });

  it("maps env-only provider credentials to external installs", () => {
    expect(
      resolveOfficialExternalProviderPluginIdsForEnv({
        GROQ_API_KEY: "groq-key",
        MODELSTUDIO_API_KEY: "qwen-key",
      }),
    ).toEqual(["groq", "qwen"]);
    expect(resolveOfficialExternalProviderPluginIdsForEnv({ GROQ_API_KEY: " " })).toEqual([]);
  });
});
