import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import {
  readSnapshotExportEnvelope,
  verifyPostgresExportEnvelope,
  writePostgresExportEnvelope,
  type PostgresExportEnvelope,
} from "./export-envelope.js";
import { readSnapshotManifest } from "./manifest.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotManifest,
} from "./snapshot-provider.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const identity = {
  engine: "postgres" as const,
  storeId: "91fbe993-c1a9-4cbb-a671-466f8f777074",
  namespace: "openclaw_workboard_test",
};
const anchorBytes = Buffer.from(JSON.stringify(identity));
const allocationFacts = (value: string) => ({
  tables: {},
  allocations: { id: { value, called: true } },
});
const artifacts = ["database.sqlite", "anchor.sqlite"] as const;

// Stand-in for the store owner's anchor decoder; the envelope owns file custody and matching.
async function inspectAnchor(handle: FileHandle) {
  const bytes = Buffer.alloc(anchorBytes.length);
  await handle.read(bytes, 0, bytes.length, 0);
  return JSON.parse(bytes.toString("utf8")) as typeof identity;
}

let directory: string;
let manifest: PostgresExportEnvelope;
const verify = (profile: PostgresExportEnvelope["profile"] = "exact") =>
  verifyPostgresExportEnvelope(directory, manifest, inspectAnchor, profile);
const read = () => readSnapshotExportEnvelope(directory);
const write = () => writePostgresExportEnvelope(directory, manifest);
const writeJson = (value: unknown) =>
  fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(value));

describe("export envelopes", () => {
  beforeEach(async () => {
    directory = tempDirs.make("openclaw-export-envelope-");
    const data = Buffer.from([0, 255]);
    await fs.writeFile(path.join(directory, "database.sqlite"), data);
    await fs.writeFile(path.join(directory, "anchor.sqlite"), anchorBytes);
    const artifact = (bytes: Buffer) => ({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    });
    manifest = {
      schemaVersion: 2,
      snapshotId: path.basename(directory),
      createdAt: "2026-10-12T12:00:00.000Z",
      profile: "exact",
      source: { ...identity, owner: "workboard", schemaVersion: 7 },
      exportSchemaVersion: 7,
      activeFragments: ["workboard"],
      verification: {
        ...allocationFacts("9223372036854775807"),
        tables: { cards: { rows: 1, sha256: "1".repeat(64) } },
      },
      artifacts: { "database.sqlite": artifact(data), "anchor.sqlite": artifact(anchorBytes) },
      sanitizedDifferences: [],
    };
  });

  it("round-trips matched PostgreSQL artifacts and exact bigint allocation facts", async () => {
    await write();
    expect(await read()).toEqual({ engine: "postgres", manifest });
    await expect(verify()).resolves.toBeUndefined();
    await expect(write()).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("continues reading unchanged format-1 manifests through the native parser", async () => {
    const legacyManifest = {
      schemaVersion: 1,
      snapshotId: path.basename(directory),
      createdAt: "2026-10-12T12:00:00.000Z",
      database: { role: "generic", id: "workboard", basename: "workboard.sqlite", userVersion: 7 },
      artifact: { path: "database.sqlite", sha256: "a".repeat(64), sizeBytes: 1024 },
    };
    await writeJson(legacyManifest);
    expect(await read()).toEqual({ engine: "sqlite", manifest: legacyManifest });
    await writeJson({ ...legacyManifest, sourceEngine: "sqlite" });
    await expect(read()).rejects.toThrow("fields must be exactly");
  });

  it.each(artifacts)("refuses changed %s bytes", async (name) => {
    await fs.appendFile(path.join(directory, name), "changed");
    await expect(verify()).rejects.toThrow(`verification failed: ${name}`);
  });

  it("refuses a correctly hashed anchor belonging to another store", async () => {
    manifest.source.storeId = "91111111-c1a9-4cbb-a671-466f8f777074";
    await expect(verify()).rejects.toThrow("does not match the source store identity");
  });

  it.each(
    artifacts.flatMap((name) => ["wal", "shm", "journal"].map((suffix) => `${name}-${suffix}`)),
  )("refuses unmanifested SQLite sidecar %s", async (name) => {
    await fs.writeFile(path.join(directory, name), "unmanifested pages");
    await expect(verify()).rejects.toThrow("unexpected SQLite sidecar");
  });

  it("never accepts sanitized user backups as exact recovery exports", async () => {
    manifest.profile = "user-backup";
    manifest.sanitizedDifferences = ["leases"];
    await write();
    await expect(verify()).rejects.toThrow("profile does not match");
    await expect(verify("user-backup")).resolves.toBeUndefined();
    manifest.profile = "exact";
    await expect(verify()).rejects.toThrow("must not contain sanitization");
  });

  it.each([
    ["unsupported version", { schemaVersion: 3 }],
    ["unknown connection field", { connectionString: "forbidden" }],
    ["mismatched directory", { snapshotId: "other" }],
    ["unsafe owner", { source: { ...identity, owner: "../workboard", schemaVersion: 7 } }],
    ["inexact allocation", { verification: allocationFacts("9223372036854775808") }],
  ])("refuses %s", async (_label, fields) => {
    await writeJson({ ...manifest, ...fields });
    await expect(read()).rejects.toThrow();
  });
});

describe("snapshot manifest parser", () => {
  const snapshotId = "snapshot";
  const validManifest: SnapshotManifest = {
    schemaVersion: 1,
    snapshotId,
    createdAt: "2026-07-12T14:00:00.000Z",
    database: {
      role: "agent",
      agentId: "worker-1",
      basename: "openclaw-agent.sqlite",
      userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    artifact: {
      path: SNAPSHOT_SQLITE_FILENAME,
      sha256: "a".repeat(64),
      sizeBytes: 4096,
    },
  };
  function manifestWith(
    overrides: {
      createdAt?: string;
      extra?: boolean;
      database?: Partial<SnapshotManifest["database"]>;
      artifact?: Omit<Partial<SnapshotManifest["artifact"]>, "path"> & { path?: string };
    } = {},
  ) {
    return {
      ...validManifest,
      ...overrides,
      database: { ...validManifest.database, ...overrides.database },
      artifact: { ...validManifest.artifact, ...overrides.artifact },
    };
  }

  it.each([
    ["unknown top-level field", manifestWith({ extra: true }), /fields must be exactly/u],
    ["wrong directory id", validManifest, /does not match directory/u, "other"],
    ["timestamp", manifestWith({ createdAt: "2026-07-12T14:00:00Z" }), /not canonical/u],
    [
      "path traversal",
      manifestWith({ artifact: { path: "../database.sqlite" } }),
      /artifact\.path must be database\.sqlite/u,
    ],
    [
      "prefixed digest",
      manifestWith({ artifact: { sha256: `sha256:${"a".repeat(64)}` } }),
      /sha256 is invalid/u,
    ],
    ["agent id", manifestWith({ database: { agentId: "Worker-1" } }), /agentId is invalid/u],
    ["basename", manifestWith({ database: { basename: "../db.sqlite" } }), /basename is invalid/u],
    [
      "user version",
      manifestWith({ database: { userVersion: 2 ** 31 } }),
      /userVersion is invalid/u,
    ],
    ["empty artifact", manifestWith({ artifact: { sizeBytes: 0 } }), /sizeBytes is invalid/u],
  ])("rejects %s", async (_name, value, error, expectedId = snapshotId) => {
    const snapshotDir = path.join(tempDirs.make("openclaw-manifest-parser-"), expectedId);
    await fs.mkdir(snapshotDir);
    await fs.writeFile(
      path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME),
      JSON.stringify(value),
      "utf8",
    );

    await expect(readSnapshotManifest(snapshotDir)).rejects.toThrow(error);
  });
});
