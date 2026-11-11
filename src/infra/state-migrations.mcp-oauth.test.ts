import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { clearMcpOAuthCredentials } from "../agents/mcp-oauth.js";
import * as pidAlive from "../shared/pid-alive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withRestoredMocks } from "../test-utils/vitest-spies.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "./sqlite-worker-contract.js";
import { withGatewayLockHeld } from "./state-migrations.gateway-lock.test-support.js";
import {
  measureMcpMigrationHostSql,
  observeLegacyMcpOAuthImport,
} from "./state-migrations.mcp-oauth-faults.test-support.js";
import { isDefinitelyStaleLegacyMcpOAuthLock } from "./state-migrations.mcp-oauth-lock-stale.js";
import {
  detectLegacyMcpOAuthStores,
  migrateLegacyMcpOAuthStores,
} from "./state-migrations.mcp-oauth.js";
import { resolveLegacyMigrationSourceKey } from "./state-migrations.receipts.js";

type MigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "mcp_oauth_stores" | "migration_sources"
>;
type LegacySource = { fileName?: string; value?: unknown; bytes?: Buffer };

const DEFAULT_FILE_NAME = "server-0123456789abcdef.json";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  });
});

let env: NodeJS.ProcessEnv;
let stateDir: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-mcp-oauth-migration-");
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
});

function database() {
  return openOpenClawStateDatabase({ env }).db;
}
const sql = () => getNodeSqliteKysely<MigrationDatabase>(database());

async function writeLegacy(params: LegacySource = {}): Promise<string> {
  const sourcePath = path.join(stateDir, "mcp-oauth", params.fileName ?? DEFAULT_FILE_NAME);
  await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
  await fsp.writeFile(
    sourcePath,
    params.bytes ?? Buffer.from(JSON.stringify(params.value ?? validStore()), "utf8"),
  );
  return sourcePath;
}

function validStore(overrides: Record<string, unknown> = {}) {
  return {
    clientInformation: {
      client_id: "client-1",
      client_secret: "fake",
      redirect_uris: ["http://127.0.0.1:8989/oauth/callback"],
      vendor_extension: "preserve-client-extension",
    },
    tokens: {
      access_token: "test-token-placeholder",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "test-auth-token",
      vendor_extension: "preserve-token-extension",
    },
    tokenExpiresAt: 10_000,
    codeVerifier: "verifier-1",
    discoveryState: {
      authorizationServerUrl: "https://auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
        vendor_extension: "preserve-metadata-extension",
      },
      resourceMetadata: {
        resource: "https://mcp.example.com",
        authorization_servers: ["https://auth.example.com"],
        vendor_extension: "preserve-resource-extension",
      },
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
    },
    lastAuthorizationUrl: "https://auth.example.com/authorize?client_id=client-1",
    redirectUrl: "http://localhost:8989/oauth/callback",
    state: "dead-and-not-imported",
    ...overrides,
  };
}

function storeRow(storeKey = DEFAULT_FILE_NAME.slice(0, -5)) {
  return executeSqliteQueryTakeFirstSync(
    database(),
    sql().selectFrom("mcp_oauth_stores").selectAll().where("store_key", "=", storeKey),
  );
}

function receipt(sourcePath?: string) {
  const query = sql()
    .selectFrom("migration_sources")
    .selectAll()
    .where("migration_kind", "=", "legacy-mcp-oauth-json");
  return executeSqliteQueryTakeFirstSync(
    database(),
    sourcePath ? query.where("source_path", "=", sourcePath) : query,
  );
}

const stored = (storeKey?: string) => JSON.parse(storeRow(storeKey)?.store_json ?? "null");
const report = (sourcePath: string) => JSON.parse(receipt(sourcePath)?.report_json ?? "null");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function expectFiles(present: string[], absent: string[] = []) {
  for (const file of present) {
    expect(fs.existsSync(file)).toBe(true);
  }
  for (const file of absent) {
    expect(fs.existsSync(file)).toBe(false);
  }
}

async function observingImport<T>(
  sourcePath: string,
  mode: Parameters<typeof observeLegacyMcpOAuthImport>[1],
  run: (observation: ReturnType<typeof observeLegacyMcpOAuthImport>) => Promise<T>,
) {
  const observation = observeLegacyMcpOAuthImport(
    resolveLegacyMigrationSourceKey("mcp-oauth-json", sourcePath),
    mode,
  );
  try {
    return await run(observation);
  } finally {
    observation.restore();
  }
}

function seedCanonical(
  store: Record<string, unknown>,
  storeKey = DEFAULT_FILE_NAME.slice(0, -5),
): void {
  executeSqliteQuerySync(
    database(),
    sql()
      .insertInto("mcp_oauth_stores")
      .values({
        store_key: storeKey,
        format_version: 1,
        store_json: JSON.stringify(store),
        updated_at: 123,
      }),
  );
}

function deleteCanonical(): void {
  executeSqliteQuerySync(database(), sql().deleteFrom("mcp_oauth_stores"));
}

async function migrate(
  overrides: {
    beforeLegacyLock?: (sourcePath: string) => void;
    beforeClaim?: (sourcePath: string) => void;
    removeSource?: (sourcePath: string) => Promise<void> | void;
  } = {},
) {
  return await migrateLegacyMcpOAuthStores({
    detected: detectLegacyMcpOAuthStores({ stateDir, doctorOnlyStateMigrations: true }),
    env,
    stateDir,
    ...overrides,
  });
}

it("detects only exact store names and interrupted claims during explicit Doctor repair", async () => {
  const sourcePath = await writeLegacy();
  await writeLegacy({ fileName: "server-0123456789ABCDE0.json" });
  await writeLegacy({ fileName: "server-0123456789abcdef.json.backup" });
  expect(detectLegacyMcpOAuthStores({ stateDir }).hasLegacy).toBe(false);
  expect(
    detectLegacyMcpOAuthStores({ stateDir, doctorOnlyStateMigrations: true }).sourcePaths,
  ).toEqual([sourcePath]);

  await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
  expect(
    detectLegacyMcpOAuthStores({ stateDir, doctorOnlyStateMigrations: true }).sourcePaths,
  ).toEqual([sourcePath]);
});

it("imports validated fields, preserves SDK extensions, drops dead state, and records a receipt", async () => {
  const bytes = Buffer.from(`${JSON.stringify(validStore())}\n`, "utf8");
  const sourcePath = await writeLegacy({ bytes });
  const { result, hostQueries } = await measureMcpMigrationHostSql(() => migrate());
  expect(result.warnings).toEqual([]);
  expect(result.changes).toContain(`Migrated MCP OAuth store ${DEFAULT_FILE_NAME} to SQLite.`);
  expect(fs.existsSync(sourcePath)).toBe(false);
  const row = storeRow();
  expect(row?.format_version).toBe(1);
  const imported = JSON.parse(row?.store_json ?? "null");
  const expected = Object.fromEntries(
    Object.entries(validStore()).filter(([key]) => key !== "state"),
  );
  expect(imported).toEqual(expected);
  expect(imported).not.toHaveProperty("state");
  expect(receipt(sourcePath)).toMatchObject({
    removed_source: 1,
    source_record_count: 1,
    status: "completed",
    target_table: "mcp_oauth_stores",
    source_sha256: digest(bytes),
  });
  expect(report(sourcePath)).toMatchObject({
    importedRecordCount: 1,
    preservedSqliteRecordCount: 0,
    storeKey: DEFAULT_FILE_NAME.slice(0, -5),
  });
  expect(hostQueries).toEqual([]);
});

it("imports an exact 4 MiB UTF-8 source through the existing worker message bound", async () => {
  const value = validStore();
  value.tokens.vendor_extension = "";
  const remaining = 4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(value), "utf8");
  const extension = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  value.tokens.vendor_extension = extension;
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  expect(bytes.byteLength).toBe(4 * 1024 * 1024);
  const sourcePath = await writeLegacy({ bytes });
  await observingImport(sourcePath, "observe", async (observation) => {
    const { result, hostQueries } = await measureMcpMigrationHostSql(() => migrate());
    expect(result.warnings).toEqual([]);
    expect(hostQueries).toEqual([]);
    expect(observation.importCount()).toBe(1);
    expect(observation.importInputBytes()).toBeGreaterThan(0);
    expect(observation.importInputBytes()).toBeLessThanOrEqual(SQLITE_WORKER_MAX_MESSAGE_BYTES);
  });
  expect(stored().tokens.vendor_extension).toBe(extension);
  expect(receipt(sourcePath)).toMatchObject({
    source_size_bytes: bytes.byteLength,
    source_sha256: digest(bytes),
    removed_source: 1,
  });
  expectFiles([], [sourcePath, `${sourcePath}.doctor-importing`]);
});

it.each(["publication-error", "result-delivery-error", "native-exit"] as const)(
  "retains the actual import outcome across %s failure",
  async (mode) => {
    const bytes = Buffer.from(JSON.stringify(validStore()), "utf8");
    const sourcePath = await writeLegacy({ bytes });
    const claimPath = `${sourcePath}.doctor-importing`;
    let result: Awaited<ReturnType<typeof migrate>>;
    try {
      result = await observingImport(sourcePath, mode, async (fault) => {
        const migrated = await migrate();
        expect(fault.injected()).toBe(true);
        expect(fault.importCount()).toBe(1);
        if (mode === "native-exit") {
          expect(fault.exitThreadId()).toBe(fault.writerThreadId());
        }
        return migrated;
      });
    } finally {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
    }
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(stored().tokens).toEqual(validStore().tokens);
    expect(receipt(sourcePath)).toMatchObject({
      source_sha256: digest(bytes),
      removed_source: mode === "native-exit" ? 0 : 1,
    });
    if (mode !== "native-exit") {
      if (mode === "publication-error") {
        expect(result.warnings).toEqual([]);
      } else {
        expect(result.warnings.join("\n")).toContain(
          "MCP OAuth import committed, but result delivery failed:",
        );
      }
      expect(result.changes).toContain(`Migrated MCP OAuth store ${DEFAULT_FILE_NAME} to SQLite.`);
      expect(fs.existsSync(claimPath)).toBe(false);
    } else {
      expect(result.warnings.join("\n")).toContain(
        "SQLite import outcome is unresolved; retained Doctor claim",
      );
      expect(result.changes).toEqual([]);
      expect(await fsp.readFile(claimPath)).toEqual(bytes);
      // The receipt, not credential existence, owns recovery; replay must not resurrect this row.
      deleteCanonical();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      await observingImport(sourcePath, "observe", async (retryObservation) => {
        const retry = await migrate();
        expect(retry.warnings).toEqual([]);
        expect(retryObservation.importCount()).toBe(0);
      });
      expect(storeRow()).toBeUndefined();
      expect(fs.existsSync(claimPath)).toBe(false);
      expect(receipt(sourcePath)).toMatchObject({ removed_source: 1 });
    }
  },
);

it("restores the exact source after the worker rejects canonical credential state before commit", async () => {
  const canonical = { credentialState: "invalid" };
  seedCanonical(canonical);
  const bytes = Buffer.from(JSON.stringify(validStore()), "utf8");
  const sourcePath = await writeLegacy({ bytes });
  const result = await observingImport(sourcePath, "observe", async (observation) => {
    const migrated = await migrate();
    expect(observation.importCount()).toBe(1);
    return migrated;
  });
  expect(result.warnings.join("\n")).toContain("credentialState is invalid");
  expect(result.changes).toEqual([]);
  expect(await fsp.readFile(sourcePath)).toEqual(bytes);
  expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  expect(receipt(sourcePath)).toBeUndefined();
  expect(storeRow()).toMatchObject({ format_version: 1, store_json: JSON.stringify(canonical) });
});

it("merges legacy credentials into challenge-only SQLite state", async () => {
  const pendingAuthorizationChallenge = {
    resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
    scope: "docs.read",
  };
  seedCanonical({ credentialState: "uninitialized", pendingAuthorizationChallenge });
  const sourcePath = await writeLegacy();

  const result = await migrate();

  expect(result.warnings).toEqual([]);
  expect(stored()).toMatchObject({
    pendingAuthorizationChallenge,
    tokens: { access_token: "test-token-placeholder", refresh_token: "test-auth-token" },
  });
  expect(stored()).not.toHaveProperty("credentialState");
  expect(stored()).not.toHaveProperty("discoveryState");
  expect(fs.existsSync(sourcePath)).toBe(false);
  expect(report(sourcePath)).toMatchObject({
    importedRecordCount: 1,
    preservedSqliteRecordCount: 1,
  });
});

it("does not resurrect retired JSON after an explicit logout", async () => {
  const identity = operatorMcpOAuthIdentity("Remote Docs", "https://mcp.example.com/mcp");
  const storeKey = identity.storeKey;
  const sourcePath = await writeLegacy({ fileName: `${storeKey}.json` });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

  await clearMcpOAuthCredentials(identity);
  expect(stored(storeKey)).toEqual({ credentialState: "cleared" });

  const result = await migrate();

  expect(result.warnings).toEqual([]);
  expect(result.changes).toContain(
    `Preserved canonical SQLite MCP OAuth store for ${storeKey}.json.`,
  );
  expect(stored(storeKey)).toEqual({ credentialState: "cleared" });
  expect(fs.existsSync(sourcePath)).toBe(false);
  expect(report(sourcePath)).toMatchObject({
    importedRecordCount: 0,
    preservedSqliteRecordCount: 1,
  });
});

it("rejects malformed and unexpected store shapes without mutation", async () => {
  const privateMarker = "must-not-appear-in-doctor-output";
  const malformedPath = await writeLegacy({
    value: validStore({ tokens: { access_token: 42, token_type: "Bearer" } }),
  });
  const unexpectedPath = await writeLegacy({
    fileName: "other-1234567890abcdef.json",
    value: { ...validStore(), unexpected: true },
  });
  const invalidJsonPath = await writeLegacy({
    fileName: "syntax-1234567890abcdef.json",
    bytes: Buffer.from(`{"tokens":{"access_token":${privateMarker}}}`, "utf8"),
  });

  const result = await migrate();

  expect(result.warnings).toHaveLength(3);
  expect(result.warnings.join("\n")).toContain("tokens are invalid");
  expect(result.warnings.join("\n")).toContain("unexpected field");
  expect(result.warnings.join("\n")).not.toContain(privateMarker);
  expectFiles([malformedPath, unexpectedPath, invalidJsonPath]);
  expect([storeRow(), receipt()]).toEqual([undefined, undefined]);
});

it("drops an orphaned legacy token expiry during import", async () => {
  const sourcePath = await writeLegacy({ value: { tokenExpiresAt: 10_000 } });

  const result = await migrate();

  expect(result.warnings).toEqual([]);
  expect(stored()).toEqual({});
  expect(fs.existsSync(sourcePath)).toBe(false);
});

it.skipIf(process.platform === "win32").each([
  ["before detection", "Failed reading legacy MCP OAuth directory"],
  ["at the lock boundary", "Failed locking legacy MCP OAuth store"],
])("rejects a symlinked legacy directory %s", async (timing, warning) => {
  const sourceDir = path.join(stateDir, "mcp-oauth");
  const displacedDir = `${sourceDir}.displaced`;
  const externalDir = tempDirs.make("openclaw-mcp-oauth-external-");
  const externalSource = path.join(externalDir, DEFAULT_FILE_NAME);
  await fsp.writeFile(externalSource, JSON.stringify(validStore()));
  const atLock = timing === "at the lock boundary";
  if (atLock) {
    await writeLegacy();
  } else {
    await fsp.symlink(externalDir, sourceDir, "dir");
  }
  const beforeLegacyLock = () => {
    fs.renameSync(sourceDir, displacedDir);
    fs.symlinkSync(externalDir, sourceDir, "dir");
  };
  const result = await migrate(atLock ? { beforeLegacyLock } : {});
  expect(result).toMatchObject({ changes: [], warnings: [expect.stringContaining(warning)] });
  expectFiles([externalSource], [`${externalSource}.lock`]);
  if (atLock) {
    expectFiles([path.join(displacedDir, DEFAULT_FILE_NAME)]);
  }
  expect(storeRow()).toBeUndefined();
});

it("imports a valid interrupted claim", async () => {
  const sourcePath = await writeLegacy();
  const claimPath = `${sourcePath}.doctor-importing`;
  await fsp.rename(sourcePath, claimPath);

  const result = await migrate();

  expect(result.warnings).toEqual([]);
  expect(storeRow()).toBeDefined();
  expectFiles([], [sourcePath, claimPath]);
});

it("uses the receipt for cleanup-only retries and cannot resurrect deleted canonical state", async () => {
  const sourcePath = await writeLegacy();
  const first = await migrate({
    removeSource: () => {
      throw new Error("simulated unlink failure");
    },
  });
  expect(first.warnings[0]).toContain("legacy cleanup failed");
  expect(storeRow()).toBeDefined();
  expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
  expect(receipt(sourcePath)).toMatchObject({ removed_source: 0 });

  deleteCanonical();
  await writeLegacy({
    value: validStore({ tokens: { access_token: "decoy-token", token_type: "Bearer" } }),
  });
  const retry = await migrate();

  expect(retry.warnings).toEqual([]);
  expect(retry.changes).toContain(
    "Discarded recreated retired MCP OAuth JSON without importing it.",
  );
  expect(storeRow()).toBeUndefined();
  expectFiles([], [sourcePath, `${sourcePath}.doctor-importing`]);
  expect(receipt(sourcePath)).toMatchObject({ removed_source: 1 });
});

it.each([
  "symlink",
  "hardlink",
  "oversized",
  "invalid-utf8",
  "changed",
  "duplicate",
  "busy",
] as const)("rejects %s sources", async (kind) => {
  const sourcePath = await writeLegacy({
    bytes:
      kind === "oversized"
        ? Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)
        : kind === "invalid-utf8"
          ? Buffer.from([0xff, 0xfe])
          : undefined,
  });
  if (kind === "symlink" || kind === "hardlink") {
    const target = path.join(stateDir, "outside.json");
    await fsp.writeFile(target, JSON.stringify(validStore()), "utf8");
    await fsp.unlink(sourcePath);
    await (kind === "symlink" ? fsp.symlink(target, sourcePath) : fsp.link(target, sourcePath));
  }
  if (kind === "duplicate") {
    await fsp.copyFile(sourcePath, `${sourcePath}.doctor-importing`);
  }
  const run = () =>
    migrate(
      kind === "changed"
        ? {
            beforeClaim: (candidate) => fs.appendFileSync(candidate, " "),
          }
        : {},
    );
  const result = await (kind === "busy" ? withGatewayLockHeld(env, 18_790, run) : run());
  const warning =
    kind === "changed"
      ? "changed before Doctor could claim it"
      : kind === "duplicate"
        ? "source and interrupted claim both exist"
        : kind === "busy"
          ? "OpenClaw state database is busy"
          : "Failed reading legacy MCP OAuth store";
  expect(result.warnings[0]).toContain(warning);
  expectFiles([sourcePath], kind === "changed" ? [`${sourcePath}.doctor-importing`] : []);
  expect([storeRow(), receipt()]).toEqual([undefined, undefined]);
});

function lockPayload(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    pid: 123,
    createdAt: "2026-07-16T00:00:00.000Z",
    starttime: 456,
    ...overrides,
  })}\n`;
}

it("fails closed for live, young, and malformed owner evidence", () => {
  return withRestoredMocks(
    [
      vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false),
      vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(456),
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-07-16T00:02:00.000Z")),
    ],
    () => {
      for (const raw of [
        lockPayload(),
        lockPayload({ createdAt: "2026-07-16T00:01:30.000Z" }),
        lockPayload({ createdAt: "invalid" }),
        lockPayload({ starttime: "456" }),
        "not json",
      ]) {
        expect(isDefinitelyStaleLegacyMcpOAuthLock({ raw })).toBe(false);
      }
    },
  );
});

it("reports a stale sidecar without unlinking a replacement-prone path", async () => {
  const sourcePath = await writeLegacy();
  const lockPath = `${sourcePath}.lock`;
  const raw = lockPayload({
    pid: 2 ** 30,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    starttime: 1,
  });
  await fsp.writeFile(lockPath, raw);
  const result = await migrate();
  expect(result.changes).toEqual([]);
  expect(result.warnings[0]).toContain("Verify no older OpenClaw process is running");
  expectFiles([sourcePath], [`${sourcePath}.doctor-importing`]);
  expect([storeRow(), receipt()]).toEqual([undefined, undefined]);
  expect(await fsp.readFile(lockPath, "utf8")).toBe(raw);
});
