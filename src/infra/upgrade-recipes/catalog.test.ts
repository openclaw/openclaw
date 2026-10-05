import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as nativeExecutor from "../../cli/update-cli/update-command-executor.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createUpdateRun } from "../update-run-ledger.js";
import type { UpdateRecoveryFence } from "../update-run-recovery.js";
import {
  authenticateUpgradeRecipeCatalog,
  assertUpgradeRecipeCatalogCurrent,
  recoverOriginalUpgradeRecipeCatalog,
  assertRecoveredUpgradeRecipeCatalogBinding,
} from "./catalog.js";
import { createRetainedUpgradeRecipeRunStore } from "./retained-run.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});
const future = "2099-01-01T00:00:00Z";
const past = "2000-01-01T00:00:00Z";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// Fixture-only TUF canonical JSON signing, never application verification code.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Non-JSON fixture");
  }
  return encoded;
}
function signed(value: Record<string, unknown>, id: string, privateKey: KeyObject): Buffer {
  return Buffer.from(
    JSON.stringify({
      signed: value,
      signatures: [
        { keyid: id, sig: sign(null, Buffer.from(canonical(value)), privateKey).toString("hex") },
      ],
    }),
  );
}
async function fixture(
  options: { version?: number; timestampExpires?: string; revoked?: boolean } = {},
) {
  const base = dirs.make("upgrade-trust-");
  const controlRoot = path.join(base, "control");
  const metadataDir = path.join(controlRoot, "metadata");
  await fs.mkdir(metadataDir, { recursive: true, mode: 0o700 });
  await fs.chmod(controlRoot, 0o700);
  const roleNames = ["root", "timestamp", "snapshot", "targets"] as const;
  const keys = roleNames.map((id) => ({ id, ...generateKeyPairSync("ed25519") }));
  const key = (id: (typeof roleNames)[number]) => {
    const found = keys.find((entry) => entry.id === id);
    if (!found) {
      throw new Error("Missing fixture key");
    }
    return found;
  };
  const version = options.version ?? 1;
  const root = signed(
    {
      _type: "root",
      spec_version: "1.0.31",
      version: 1,
      expires: future,
      consistent_snapshot: false,
      keys: Object.fromEntries(
        keys.map((entry) => [
          entry.id,
          {
            keytype: "ed25519",
            scheme: "ed25519",
            keyval: {
              public: entry.publicKey
                .export({ type: "spki", format: "der" })
                .subarray(-32)
                .toString("hex"),
            },
          },
        ]),
      ),
      roles: Object.fromEntries(roleNames.map((id) => [id, { keyids: [id], threshold: 1 }])),
    },
    "root",
    key("root").privateKey,
  );
  const target = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      catalog: {
        schemaVersion: 1,
        id: "authenticated-fixture",
        artifacts: [],
        releases: [],
        recipes: [],
        adapters: [],
        qualifications: [],
      },
      revokedRecipes: options.revoked ? [{ id: "direct", revision: 2 }] : [],
      revokedArtifactIds: options.revoked ? ["bad-bundle"] : [],
    }),
  );
  const targets = signed(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version,
      expires: future,
      targets: { "catalog.json": { length: target.length, hashes: { sha256: hash(target) } } },
    },
    "targets",
    key("targets").privateKey,
  );
  const snapshot = signed(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version,
      expires: future,
      meta: {
        "targets.json": { version, length: targets.length, hashes: { sha256: hash(targets) } },
      },
    },
    "snapshot",
    key("snapshot").privateKey,
  );
  const timestamp = signed(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version,
      expires: options.timestampExpires ?? future,
      meta: {
        "snapshot.json": { version, length: snapshot.length, hashes: { sha256: hash(snapshot) } },
      },
    },
    "timestamp",
    key("timestamp").privateKey,
  );
  await fs.writeFile(path.join(metadataDir, "root.json"), root, { mode: 0o600 });
  const remote = new Map<string, Buffer>([
    ["https://updates.example/metadata/timestamp.json", timestamp],
    ["https://updates.example/metadata/snapshot.json", snapshot],
    ["https://updates.example/metadata/targets.json", targets],
    ["https://updates.example/targets/catalog.json", target],
  ]);
  const fetch = vi.fn(async (input: unknown) => {
    const bytes = remote.get(String(input));
    return bytes ? new Response(bytes.toString("utf8")) : new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    controlRoot,
    metadataDir,
    remote,
    fetch,
    key,
    timestamp,
    target,
    options: {
      controlRoot,
      metadataDir,
      metadataBaseUrl: "https://updates.example/metadata/",
      targetBaseUrl: "https://updates.example/targets/",
      targetPath: "catalog.json",
      forbiddenRoots: [path.join(base, "workspace"), path.join(base, "installation")],
    },
  };
}

describe("authenticated upgrade catalogs", () => {
  it("refuses another process's trust-cache lock before fetching or replacing metadata", async () => {
    const f = await fixture();
    const lock = `${f.metadataDir}.refresh.lock`;
    const bytes = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
    await fs.writeFile(lock, bytes, { mode: 0o600, flag: "wx" });
    await expect(authenticateUpgradeRecipeCatalog(f.options)).rejects.toMatchObject({
      code: "metadata-untrusted",
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await fs.readFile(lock, "utf8")).toBe(bytes);
    await expect(
      authenticateUpgradeRecipeCatalog({ ...f.options, controlRoot: path.dirname(f.controlRoot) }),
    ).rejects.toMatchObject({ code: "metadata-untrusted" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("serializes same-process refreshes through the trust-cache lock", async () => {
    const f = await fixture();
    const fetching = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementationOnce(async (input) => {
      fetching.resolve();
      await release.promise;
      return fetch(input);
    });
    const first = authenticateUpgradeRecipeCatalog(f.options);
    await fetching.promise;
    try {
      await expect(authenticateUpgradeRecipeCatalog(f.options)).rejects.toMatchObject({
        code: "metadata-untrusted",
      });
      expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await first;
    }
  });
  it("invalidates admitted plans when another process changes retained trust metadata", async () => {
    const f = await fixture();
    const admitted = await authenticateUpgradeRecipeCatalog(f.options);
    await fs.appendFile(path.join(f.metadataDir, "timestamp.json"), " ");
    expect(() => assertUpgradeRecipeCatalogCurrent(admitted)).toThrow(/another invocation/);
  });
  it("verifies real role signatures and pins immutable target and trust evidence", async () => {
    const f = await fixture();
    const result = await authenticateUpgradeRecipeCatalog(f.options);
    expect(result.catalog.id).toBe("authenticated-fixture");
    expect(result.digest).toBe(hash(f.target));
    expect(result.admission).toMatchObject({
      sha256: hash(f.target),
      length: f.target.length,
      targetPath: "catalog.json",
      metadataVersions: { root: 1, timestamp: 1, snapshot: 1, targets: 1 },
    });
    expect(Object.isFrozen(result.catalog.artifacts)).toBe(true);
    expect(() => assertUpgradeRecipeCatalogCurrent(result)).not.toThrow();
    expect(() => assertUpgradeRecipeCatalogCurrent(structuredClone(result))).toThrow(
      /authentication owner/,
    );
    expect((await fs.stat(path.join(f.metadataDir, "timestamp.json"))).mode & 0o077).toBe(0);
  });
  it("refuses expired signed metadata and subsequent new plans after admission expiry", async () => {
    const expired = await fixture({ timestampExpires: past });
    await expect(authenticateUpgradeRecipeCatalog(expired.options)).rejects.toMatchObject({
      code: "metadata-expired",
    });
    const f = await fixture();
    const result = await authenticateUpgradeRecipeCatalog(f.options);
    expect(() =>
      assertUpgradeRecipeCatalogCurrent(result, { now: Date.parse(result.admission.expiresAt) }),
    ).toThrow(/current authenticated metadata/);
  });
  it("refuses timestamp rollback using retained authenticated cache", async () => {
    const f = await fixture({ version: 2 });
    await authenticateUpgradeRecipeCatalog(f.options);
    const data = JSON.parse(f.timestamp.toString("utf8")) as { signed: Record<string, unknown> };
    const rolledBack = signed(
      { ...data.signed, version: 1 },
      "timestamp",
      f.key("timestamp").privateKey,
    );
    f.remote.set("https://updates.example/metadata/timestamp.json", rolledBack);
    await expect(authenticateUpgradeRecipeCatalog(f.options)).rejects.toMatchObject({
      code: "metadata-untrusted",
    });
    expect(
      JSON.parse(await fs.readFile(path.join(f.metadataDir, "timestamp.json"), "utf8")).signed
        .version,
    ).toBe(2);
  });
  it("refuses unauthenticated catalog bytes even when valid JSON", async () => {
    const f = await fixture();
    f.remote.set(
      "https://updates.example/targets/catalog.json",
      Buffer.from(f.target.toString().replace("authenticated-fixture", "unauthorized-fixtures")),
    );
    await expect(authenticateUpgradeRecipeCatalog(f.options)).rejects.toMatchObject({
      code: "metadata-untrusted",
    });
  });
  it("refuses a correctly shaped target role with a wrong signature", async () => {
    const f = await fixture();
    const url = "https://updates.example/metadata/targets.json";
    const bytes = f.remote.get(url);
    if (!bytes) {
      throw new Error("Missing fixture targets");
    }
    const data = JSON.parse(bytes.toString("utf8")) as { signed: Record<string, unknown> };
    // Another authorized role is not authorized to sign target metadata.
    const wrongSignature = signed(data.signed, "targets", f.key("snapshot").privateKey);
    f.remote.set(url, wrongSignature);
    // Authenticate its exact transport bytes through snapshot/timestamp so refusal
    // reaches target-role signature verification rather than transport hashing.
    const snapshot = signed(
      {
        _type: "snapshot",
        spec_version: "1.0.31",
        version: 1,
        expires: future,
        meta: {
          "targets.json": {
            version: 1,
            length: wrongSignature.length,
            hashes: { sha256: hash(wrongSignature) },
          },
        },
      },
      "snapshot",
      f.key("snapshot").privateKey,
    );
    f.remote.set("https://updates.example/metadata/snapshot.json", snapshot);
    f.remote.set(
      "https://updates.example/metadata/timestamp.json",
      signed(
        {
          _type: "timestamp",
          spec_version: "1.0.31",
          version: 1,
          expires: future,
          meta: {
            "snapshot.json": {
              version: 1,
              length: snapshot.length,
              hashes: { sha256: hash(snapshot) },
            },
          },
        },
        "timestamp",
        f.key("timestamp").privateKey,
      ),
    );
    await expect(authenticateUpgradeRecipeCatalog(f.options)).rejects.toMatchObject({
      code: "metadata-untrusted",
    });
  });
  it("enforces exact recipe revision and artifact revocations from authenticated bytes", async () => {
    const f = await fixture({ revoked: true });
    const result = await authenticateUpgradeRecipeCatalog(f.options);
    expect(() =>
      assertUpgradeRecipeCatalogCurrent(result, { recipe: { id: "direct", revision: 2 } }),
    ).toThrow(/revoked/);
    expect(() =>
      assertUpgradeRecipeCatalogCurrent(result, { artifactIds: ["bad-bundle"] }),
    ).toThrow(/revoked/);
    expect(() =>
      assertUpgradeRecipeCatalogCurrent(result, {
        recipe: { id: "direct", revision: 1 },
        artifactIds: ["good"],
      }),
    ).not.toThrow();
  });
  it("refuses missing provisioned root without fetching a trust root", async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.metadataDir, "root.json"));
    await expect(authenticateUpgradeRecipeCatalog(f.options)).rejects.toMatchObject({
      code: "metadata-untrusted",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["workspace", "permissions", "symlink", "target-traversal"])(
    "refuses unsafe trust storage: %s",
    async (kind) => {
      const f = await fixture();
      if (kind === "workspace") {
        f.options.forbiddenRoots.push(f.controlRoot);
      }
      if (kind === "permissions") {
        await fs.chmod(f.metadataDir, 0o777);
      }
      if (kind === "symlink") {
        const file = path.join(f.metadataDir, "root.json");
        const bytes = await fs.readFile(file);
        await fs.unlink(file);
        const outside = path.join(f.controlRoot, "outside.json");
        await fs.writeFile(outside, bytes, { mode: 0o600 });
        await fs.symlink(outside, file);
      }
      if (kind === "target-traversal") {
        f.options.targetPath = "../catalog.json";
      }
      await expect(authenticateUpgradeRecipeCatalog(f.options)).rejects.toMatchObject({
        code: "metadata-untrusted",
      });
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
});

it("recovers an expired original admission only through actual retained ledger custody and refuses fresh reuse/substitution", async () => {
  const f = await fixture();
  const catalog = await authenticateUpgradeRecipeCatalog(f.options);
  for (const root of f.options.forbiddenRoots) {
    await fs.mkdir(root, { mode: 0o700 });
  }
  const state = path.join(f.controlRoot, "state-owner");
  await fs.mkdir(state, { mode: 0o700 });
  const env = { OPENCLAW_STATE_DIR: state };
  const database = openOpenClawStateDatabase({ env });
  const run = createUpdateRun({ trigger: "cli" }, { env });
  const ledgerPath = database.path;
  closeOpenClawStateDatabaseForTest();
  const nativeFile = path.join(f.controlRoot, "native-leases.sqlite");
  await fs.writeFile(nativeFile, "fixture native lease", { mode: 0o600 });
  const nativeStat = await fs.stat(nativeFile),
    nativeParent = await fs.stat(f.controlRoot);
  vi.spyOn(nativeExecutor, "captureUpdateCommandExecutorAuthority").mockReturnValue({
    installKey: f.options.forbiddenRoots[1]!,
    databasePath: nativeFile,
    databaseIdentity: `${nativeStat.dev}:${nativeStat.ino}`,
    parentIdentity: `${nativeParent.dev}:${nativeParent.ino}`,
    owner: "original-owner",
  });
  const root = path.join(f.controlRoot, "retained");
  await fs.mkdir(root, { mode: 0o700 });
  const runner = path.join(f.controlRoot, "runner");
  await fs.mkdir(runner, { mode: 0o700 });
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("original custody lost");
    }
  };
  const binding = {
    protocol: 1 as const,
    runId: run.runId,
    planDigest: "a".repeat(64),
    targetArtifactId: "target",
    installationKey: f.options.forbiddenRoots[1]!,
    stateRootKey: state,
  };
  const authorization = Buffer.from(JSON.stringify(catalog));
  const store = createRetainedUpgradeRecipeRunStore({ path: ledgerPath, env, assertCurrent });
  const { retained } = await store.retain({
    fence: { assertCurrent } as UpdateRecoveryFence,
    runId: run.runId,
    originalCreatedAtMs: run.createdAtMs,
    root,
    forbiddenRoots: f.options.forbiddenRoots,
    envelope: {
      schemaVersion: 1,
      binding,
      runner: {
        root: runner,
        manifestDigest: "b".repeat(64),
        closureDigest: "c".repeat(64),
        runtimePath: path.join(runner, "node"),
        entrypointPath: path.join(runner, "main.mjs"),
      },
      stepBindings: [],
    },
    plan: Buffer.from(
      JSON.stringify({
        maintenance: { binding },
        catalogDigest: catalog.digest,
        catalog: f.options,
      }),
    ),
    config: Buffer.from("approved config"),
    authorization,
  });
  const recovered = await recoverOriginalUpgradeRecipeCatalog(retained, authorization, {
    path: ledgerPath,
    env,
    assertCurrent,
    catalog: f.options,
  });
  const expiredAt = Date.parse(catalog.admission.expiresAt);
  expect(() => assertUpgradeRecipeCatalogCurrent(catalog, { now: expiredAt })).toThrow(
    "current authenticated metadata",
  );
  expect(() => assertUpgradeRecipeCatalogCurrent(recovered, { now: expiredAt })).not.toThrow();
  expect(() => assertRecoveredUpgradeRecipeCatalogBinding(recovered, binding)).not.toThrow();
  expect(() =>
    assertRecoveredUpgradeRecipeCatalogBinding(recovered, {
      ...binding,
      planDigest: "d".repeat(64),
    }),
  ).toThrow("another run or plan");
  await expect(
    recoverOriginalUpgradeRecipeCatalog(retained, Buffer.from("substituted authorization"), {
      env,
      assertCurrent,
      catalog: f.options,
    }),
  ).rejects.toThrow("durable custody");
  expect(() => assertUpgradeRecipeCatalogCurrent(structuredClone(recovered))).toThrow();
  current = false;
  expect(() => assertUpgradeRecipeCatalogCurrent(recovered)).toThrow("custody lost");
});
