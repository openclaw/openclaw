import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { normalizeLegacyDeviceIdentity } from "./device-identity-legacy.js";
import {
  generateStoredDeviceIdentity,
  insertStoredDeviceIdentityIfAbsent,
  readStoredDeviceIdentityReadOnly,
} from "./device-identity-store.js";
import {
  deriveDeviceIdFromPublicKey,
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
  normalizeDevicePublicKeyBase64Url,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  verifyDeviceSignature,
  type DeviceIdentity,
} from "./device-identity.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

const SWIFT_RAW_DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const SWIFT_RAW_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const SWIFT_RAW_PRIVATE_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // pragma: allowlist secret
const MISMATCHED_SWIFT_RAW_PRIVATE_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // pragma: allowlist secret
const swiftIdentity = {
  deviceId: SWIFT_RAW_DEVICE_ID,
  publicKey: SWIFT_RAW_PUBLIC_KEY,
  privateKey: SWIFT_RAW_PRIVATE_KEY,
  createdAtMs: 1_700_000_000_000,
};
const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

function storeOptions(rootDir: string) {
  return {
    env: { ...process.env, OPENCLAW_STATE_DIR: rootDir },
    path: path.join(rootDir, "state", "openclaw.sqlite"),
  };
}

function writeRetiredIdentity(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(swiftIdentity)}\n`);
}

function makePemIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

async function openFixtureDatabase(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(filePath);
}

async function waitForChild(child: ChildProcess): Promise<DeviceIdentity> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const [code, signal] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`identity worker failed (${String(code ?? signal)}): ${stderr}`);
  }
  const resultLine = stdout.trim().split("\n").at(-1);
  if (!resultLine) {
    throw new Error("identity worker produced no result");
  }
  return JSON.parse(resultLine) as DeviceIdentity;
}

function spawnIdentityWorker(
  moduleUrl: URL,
  workerSource: string,
  rootDir: string,
  env: NodeJS.ProcessEnv = {},
  ipc = false,
) {
  return spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1),
      "--input-type=module",
      "-e",
      workerSource,
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_IDENTITY_DATABASE_PATH: path.join(rootDir, "state", "openclaw.sqlite"),
        OPENCLAW_STATE_DIR: rootDir,
        OPENCLAW_IDENTITY_MODULE: moduleUrl.href,
        ...env,
      },
      stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    },
  );
}

async function runConcurrentIdentityLoads(rootDir: string): Promise<DeviceIdentity[]> {
  const moduleUrl = resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.deviceIdentity);
  const workerSource = `
    const { loadDeviceIdentityIfPresent } = await import(process.env.OPENCLAW_IDENTITY_MODULE);
    const { default: childProcess } = await import("node:child_process");
    const { syncBuiltinESMExports } = await import("node:module");
    childProcess.spawnSync = () => { throw new Error("synthetic subprocess capacity exhausted"); };
    syncBuiltinESMExports();
    process.once("message", () => {
      const identity = loadDeviceIdentityIfPresent({
        path: process.env.OPENCLAW_IDENTITY_DATABASE_PATH,
      });
      console.log(JSON.stringify(identity));
      process.disconnect();
    });
    process.send("ready");
  `;
  const workers = Array.from({ length: 20 }, () => {
    const child = spawnIdentityWorker(moduleUrl, workerSource, rootDir, {}, true);
    const outcome = waitForChild(child);
    const ready = new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      void outcome.then(() => reject(new Error("identity worker exited before start")), reject);
    });
    return { child, outcome, ready };
  });

  try {
    await Promise.all(workers.map((worker) => worker.ready));
    for (const { child } of workers) {
      child.send("start");
    }
    return await Promise.all(workers.map((worker) => worker.outcome));
  } finally {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
    await Promise.allSettled(workers.map((worker) => worker.outcome));
  }
}

async function startPausedBootstrapCreator(rootDir: string) {
  const readyPath = path.join(rootDir, "bootstrap-ready");
  const committedPath = path.join(rootDir, "bootstrap-committed");
  const continuePath = path.join(rootDir, "bootstrap-continue");
  const storeModuleUrl = resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.deviceIdentityStore);
  const workerSource = `
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    const { generateStoredDeviceIdentity, insertStoredDeviceIdentityIfAbsent } =
      await import(process.env.OPENCLAW_IDENTITY_MODULE);
    const options = {
      path: process.env.OPENCLAW_IDENTITY_DATABASE_PATH,
    };
    fs.mkdirSync(path.dirname(options.path), { recursive: true });
    new DatabaseSync(options.path).close();
    fs.writeFileSync(process.env.OPENCLAW_IDENTITY_READY_PATH, "ready");
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(process.env.OPENCLAW_IDENTITY_CONTINUE_PATH)) {
      if (Date.now() >= deadline) throw new Error("timed out waiting to continue bootstrap");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const stored = insertStoredDeviceIdentityIfAbsent(generateStoredDeviceIdentity(), options);
    fs.writeFileSync(process.env.OPENCLAW_IDENTITY_COMMITTED_PATH, "committed");
    const { deviceId, publicKeyPem, privateKeyPem } = stored;
    console.log(JSON.stringify({ deviceId, publicKeyPem, privateKeyPem }));
  `;
  const child = spawnIdentityWorker(storeModuleUrl, workerSource, rootDir, {
    OPENCLAW_IDENTITY_COMMITTED_PATH: committedPath,
    OPENCLAW_IDENTITY_CONTINUE_PATH: continuePath,
    OPENCLAW_IDENTITY_READY_PATH: readyPath,
  });
  const outcome = waitForChild(child);
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(readyPath)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await outcome;
    }
    if (Date.now() >= deadline) {
      child.kill();
      throw new Error("timed out waiting for paused bootstrap creator");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
  }
  return { child, committedPath, continuePath, outcome };
}

function waitForFileSync(filePath: string): void {
  const deadline = Date.now() + 15_000;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    Atomics.wait(waitBuffer, 0, 0, 2);
  }
}

describe("device identity SQLite store", () => {
  let rootDir: string;
  let options: ReturnType<typeof storeOptions>;
  beforeEach(async () => {
    rootDir = await tempDirs.make("openclaw-device-identity-");
    options = storeOptions(rootDir);
  });
  it("reads a missing database without creating identity state or coordinator locks", async () => {
    const entries = fs.readdirSync(rootDir);

    expect(loadDeviceIdentityIfPresent(options)).toBeNull();
    expect([options.path, path.dirname(options.path)].map(fs.existsSync)).toEqual([false, false]);
    expect(fs.readdirSync(rootDir)).toEqual(entries);
  });

  it("reads an existing identity without changing canonical SQLite artifacts", async () => {
    const created = loadOrCreateDeviceIdentity(options);
    closeOpenClawStateDatabaseForTest();
    const databaseDirectory = path.dirname(options.path!);
    const artifactsBeforeRead = fs.readdirSync(databaseDirectory).toSorted();

    expect(withArtifactPreservingStateReads(() => loadDeviceIdentityIfPresent(options))).toEqual(
      created,
    );
    expect(fs.readdirSync(databaseDirectory).toSorted()).toEqual(artifactsBeforeRead);
  });

  it("creates and reuses the primary identity in SQLite", async () => {
    await withTempDir("openclaw-device-identity-create-", async (rootDir) => {
      const options = storeOptions(rootDir);
      const created = loadOrCreateDeviceIdentity(options);
      const loaded = loadOrCreateDeviceIdentity(options);

      expect(loaded).toEqual(created);
      expect(loadDeviceIdentityIfPresent(options)).toEqual(created);
      expect(fs.existsSync(options.path!)).toBe(true);
      expect(fs.existsSync(path.join(rootDir, "identity", "device.json"))).toBe(false);
    });
  });

  it("keeps empty-bootstrap classification on the pre-commit read snapshot", async () => {
    const creator = await startPausedBootstrapCreator(rootDir);
    try {
      const sqlite = await import("node:sqlite");
      // oxlint-disable-next-line typescript/unbound-method -- called below with the intercepted database receiver.
      const prepare = sqlite.DatabaseSync.prototype.prepare;
      let committedDuringRead = false;
      vi.spyOn(sqlite.DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: InstanceType<typeof sqlite.DatabaseSync>,
        sql,
      ) {
        try {
          return prepare.call(this, sql);
        } catch (error) {
          if (!committedDuringRead && /device_identities/iu.test(sql)) {
            committedDuringRead = true;
            fs.writeFileSync(creator.continuePath, "continue");
            waitForFileSync(creator.committedPath);
          }
          throw error;
        }
      });

      expect(
        withArtifactPreservingStateReads(() => loadDeviceIdentityIfPresent(options)),
      ).toBeNull();
      expect(committedDuringRead).toBe(true);

      const committed = await creator.outcome;
      expect(loadDeviceIdentityIfPresent(options)).toEqual(committed);
    } finally {
      if (creator.child.exitCode === null && creator.child.signalCode === null) {
        fs.writeFileSync(creator.continuePath, "continue");
        creator.child.kill();
      }
      await Promise.allSettled([creator.outcome]);
    }
  }, 30_000);

  it("does not classify a partial schema as an identity bootstrap miss", async () => {
    const database = await openFixtureDatabase(options.path);
    database.exec("CREATE TABLE unrelated_state (id INTEGER PRIMARY KEY) STRICT;");
    database.close();

    expect(() => loadDeviceIdentityIfPresent(options)).toThrow(/no such table: device_identities/);
  });

  it("adopts a Swift-created version-zero identity database and completes the shared schema", async () => {
    const expected = normalizeLegacyDeviceIdentity(swiftIdentity);
    if (!expected) {
      throw new Error("Swift identity fixture must normalize");
    }
    const database = await openFixtureDatabase(options.path);
    database.exec(`
        CREATE TABLE device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY, device_id TEXT NOT NULL,
          public_key_pem TEXT NOT NULL, private_key_pem TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_device_identities_device ON device_identities(device_id, updated_at_ms DESC);
      `);
    database
      .prepare("INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "primary",
        expected.deviceId,
        expected.publicKeyPem,
        expected.privateKeyPem,
        expected.createdAtMs,
        expected.createdAtMs,
      );
    database.close();

    const { createdAtMs: _createdAtMs, ...identity } = expected;
    expect(loadOrCreateDeviceIdentity(options)).toEqual(identity);
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = await import("node:sqlite");
    const verified = new DatabaseSync(options.path, { readOnly: true });
    expect(verified.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      verified
        .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ role: "global", schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
    verified.close();
  });

  it("keeps canonical SQLite authoritative when retired device.json reappears", async () => {
    const canonical = loadOrCreateDeviceIdentity(options);
    expect(canonical.deviceId).not.toBe(SWIFT_RAW_DEVICE_ID);
    closeOpenClawStateDatabaseForTest();

    const legacyPath = path.join(rootDir, "identity", "device.json");
    writeRetiredIdentity(legacyPath);

    expect(loadDeviceIdentityIfPresent(options)).toEqual(canonical);
    expect(loadOrCreateDeviceIdentity(options)).toEqual(canonical);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("loads existing identities concurrently without requiring subprocess capacity", async () => {
    const identity = loadOrCreateDeviceIdentity(options);
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = await import("node:sqlite");
    const writer = new DatabaseSync(options.path!);
    writer.exec("BEGIN IMMEDIATE");
    try {
      expect(await runConcurrentIdentityLoads(rootDir)).toEqual(
        Array.from({ length: 20 }, () => identity),
      );
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("rechecks pending native import before publishing a generated identity", async () => {
    expect(loadDeviceIdentityIfPresent(options)).toBeNull();
    const candidate = generateStoredDeviceIdentity();
    const claimPath = path.join(rootDir, "identity", "device.json.native-importing");
    writeRetiredIdentity(claimPath);
    const claim = fs.readFileSync(claimPath);

    expect(() => insertStoredDeviceIdentityIfAbsent(candidate, options)).toThrow("doctor --fix");
    expect(readStoredDeviceIdentityReadOnly(options)).toBeNull();
    expect(fs.readFileSync(claimPath)).toEqual(claim);
  });

  it("fails closed for a corrupt persisted row", async () => {
    loadOrCreateDeviceIdentity(options);
    closeOpenClawStateDatabaseForTest();

    const database = await openFixtureDatabase(options.path);
    database
      .prepare("UPDATE device_identities SET device_id = ? WHERE identity_key = ?")
      .run("corrupt-device-id", "primary");
    database.close();

    expect(() => loadDeviceIdentityIfPresent(options)).toThrow(/invalid persisted device identity/);
    expect(() => loadOrCreateDeviceIdentity(options)).toThrow(/invalid persisted device identity/);
  });

  it.each(["device.json", "device.json.doctor-importing", "device.json.native-importing"])(
    "blocks SQLite access while legacy %s may exist",
    async (legacyName) => {
      const legacyPath = path.join(rootDir, "identity", legacyName);
      writeRetiredIdentity(legacyPath);

      expect(() => loadDeviceIdentityIfPresent(options)).toThrow(/doctor --fix/);
      expect(() => loadOrCreateDeviceIdentity(options)).toThrow(/doctor --fix/);
      expect(fs.existsSync(options.path!)).toBe(false);
    },
  );
  it.each([
    ["canonical", (directory: string) => path.join(directory, "state", "openclaw.sqlite")],
    ["arbitrary", (directory: string) => path.join(directory, "identity-state.sqlite")],
  ])("derives the legacy root from an explicit %s database path", async (_label, dbPath) => {
    const legacyPath = path.join(rootDir, "identity", "device.json");
    writeRetiredIdentity(legacyPath);

    expect(() => loadOrCreateDeviceIdentity({ path: dbPath(rootDir) })).toThrow(/doctor --fix/);
  });
});

describe("legacy device identity normalization", () => {
  it("normalizes valid Node PEM material and derives its canonical device id", () => {
    const legacy = {
      version: 1,
      deviceId: "stale-device-id",
      ...makePemIdentity(),
      createdAtMs: 1_700_000_000_000,
    };
    const { version: _version, ...expected } = legacy;
    expect(normalizeLegacyDeviceIdentity(legacy)).toMatchObject({
      ...expected,
      deviceId: deriveDeviceIdFromPublicKey(legacy.publicKeyPem),
    });
  });

  it("converts valid Swift raw-key material to PEM", () => {
    const normalized = normalizeLegacyDeviceIdentity({
      deviceId: SWIFT_RAW_DEVICE_ID,
      publicKey: SWIFT_RAW_PUBLIC_KEY,
      privateKey: SWIFT_RAW_PRIVATE_KEY,
      createdAtMs: 1_700_000_000_000,
    });

    expect(normalized?.deviceId).toBe(SWIFT_RAW_DEVICE_ID);
    expect(normalized?.createdAtMs).toBe(1_700_000_000_000);
    expect(crypto.createPublicKey(normalized?.publicKeyPem ?? "").asymmetricKeyType).toBe(
      "ed25519",
    );
    expect(crypto.createPrivateKey(normalized?.privateKeyPem ?? "").asymmetricKeyType).toBe(
      "ed25519",
    );
  });

  it("rejects mismatched or malformed legacy key material", () => {
    expect(
      normalizeLegacyDeviceIdentity({
        ...swiftIdentity,
        privateKey: MISMATCHED_SWIFT_RAW_PRIVATE_KEY,
      }),
    ).toBeNull();
    expect(
      normalizeLegacyDeviceIdentity({
        version: 1,
        deviceId: SWIFT_RAW_DEVICE_ID,
        publicKeyPem: "not-a-key",
        privateKeyPem: "not-a-key",
        createdAtMs: Number.NaN,
      }),
    ).toBeNull();
  });
});

describe("device identity crypto helpers", () => {
  it("preserves existing public-key wire normalization", () => {
    const { publicKeyPem } = makePemIdentity();
    const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
    const standardBase64 = `${publicKeyRaw.replaceAll("-", "+").replaceAll("_", "/")}=`;

    expect(
      [publicKeyPem, standardBase64, `${standardBase64}=`].map(normalizeDevicePublicKeyBase64Url),
    ).toEqual([publicKeyRaw, publicKeyRaw, publicKeyRaw]);
    expect(deriveDeviceIdFromPublicKey(publicKeyRaw)).toBe(
      deriveDeviceIdFromPublicKey(publicKeyPem),
    );
  });

  it("signs payloads that verify against PEM and raw public key forms", () => {
    const { publicKeyPem, privateKeyPem } = makePemIdentity();
    const payload = JSON.stringify({ action: "system.run", ts: 1234 });
    const signature = signDevicePayload(privateKeyPem, payload);
    const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);

    expect(verifyDeviceSignature(publicKeyPem, payload, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKeyRaw, payload, signature)).toBe(true);
    expect(verifyDeviceSignature(publicKeyRaw, `${payload}!`, signature)).toBe(false);
  });
});
