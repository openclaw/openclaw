import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import {
  ClientCredentialMigrationRequiredError,
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "../infra/client-credential-readiness.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import {
  seedDeviceAuthToken,
  readDeviceAuthTokenForTest,
} from "../infra/device-auth-store.test-support.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import { ExecApprovalsMigrationRequiredError } from "../infra/exec-approvals-migration-gate.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import {
  acquireGatewayStateOwner,
  GatewayStateOwnerContentionError,
} from "../infra/gateway-state-owner.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import * as doctorMaintenance from "./doctor-maintenance.js";
import { prepareStartupClientCredentials } from "./startup-client-credentials.js";

describe("automatic client credential preparation", () => {
  const dirs = useStateDatabaseTempDirs();
  afterEach(() => vi.unstubAllEnvs());
  const runtime = {
    log() {},
    error() {},
    exit(code: number) {
      throw new Error(`Unexpected startup exit ${code}`);
    },
  };
  function target() {
    const root = fs.realpathSync(dirs.make("credential-startup-"));
    return {
      root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_PROFILE: "default",
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      },
    };
  }
  async function bootstrap(postgresConnection?: string) {
    const fixture = target();
    const identity = loadOrCreateDeviceIdentity({ env: fixture.env });
    const token = seedDeviceAuthToken({
      env: fixture.env,
      deviceId: identity.deviceId,
      role: "node",
      token: "synthetic-startup-token",
      scopes: ["node.invoke"],
      updatedAtMs: 123,
    });
    const shared = path.join(fixture.root, "state", "openclaw.sqlite");
    if (postgresConnection) {
      const config = {
        database: {
          engine: "postgres" as const,
          postgres: { connection: postgresConnection, schemaPrefix: "credential_startup" },
        },
      };
      fs.writeFileSync(fixture.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
      expect(() =>
        withDatabaseEngineSelection(
          {
            effectiveEngines: resolveDatabaseFamilyEngines(config),
            postgres: config.database.postgres,
          },
          () => withEngineStoreAdmission(() => openOpenClawStateDatabase({ env: fixture.env })),
        ),
      ).toThrow(/ECONNREFUSED/);
    } else {
      openOpenClawStateDatabase({ env: fixture.env });
    }
    await closeOpenClawStateDatabaseAsync();
    return {
      ...fixture,
      identity,
      token,
      shared,
      local: resolveClientCredentialStorePath(fixture.env),
    };
  }
  function changeRecordedDevice(env: NodeJS.ProcessEnv) {
    using owner = openClientCredentialCustody(env, { migration: true });
    expect(owner).toBeDefined();
    const stored = readClientCredentialReceipt(owner!.database)!;
    stored.receipt.sharedFile!.dev = String(BigInt(stored.receipt.sharedFile!.dev) + 1000n);
    owner!.transaction(() =>
      writeClientCredentialReceipt(owner!.database, stored.receipt, stored.phase),
    );
  }
  function restoreLegacyBootstrapReceipt(env: NodeJS.ProcessEnv) {
    using owner = openClientCredentialCustody(env, { migration: true })!;
    const stored = readClientCredentialReceipt(owner.database)!;
    stored.receipt.source = null;
    owner.transaction(() =>
      writeClientCredentialReceipt(owner.database, stored.receipt, "complete"),
    );
  }
  function snapshotFiles(root: string) {
    return Object.fromEntries(
      fs.readdirSync(root, { recursive: true }).map((entry) => {
        const relative = String(entry);
        const pathname = path.join(root, relative);
        return [relative, fs.statSync(pathname).isDirectory() ? null : fs.readFileSync(pathname)];
      }),
    );
  }

  it.each([
    { filename: "identity/node-device-auth.json", claim: "auth:node", kind: "auth" },
    { filename: "exec-approvals.json", claim: undefined, kind: "approvals" },
  ] as const)(
    "preserves all files before refusing malformed required $kind",
    async ({ filename, claim, kind }) => {
      const fixture = await bootstrap();
      if (claim) {
        using owner = openClientCredentialCustody(fixture.env, { migration: true })!;
        const stored = readClientCredentialReceipt(owner.database)!;
        delete stored.receipt.legacyImports[claim];
        owner.transaction(() =>
          writeClientCredentialReceipt(owner.database, stored.receipt, "complete"),
        );
      }
      const sourcePath = path.join(fixture.root, filename);
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, '{"retiredCredential":"preserve for recovery"}');
      const before = snapshotFiles(fixture.root);
      await expect(
        prepareStartupClientCredentials({ env: fixture.env, runtime, config: {} }),
      ).rejects.toThrow(
        kind === "approvals"
          ? ExecApprovalsMigrationRequiredError
          : ClientCredentialMigrationRequiredError,
      );
      expect(snapshotFiles(fixture.root)).toEqual(before);
    },
  );

  it("ignores obsolete canonical and consumed JSON while importing required sibling auth", async () => {
    const fixture = await bootstrap();
    {
      using owner = openClientCredentialCustody(fixture.env, { migration: true })!;
      const stored = readClientCredentialReceipt(owner.database)!;
      delete stored.receipt.legacyImports["identity:primary"];
      delete stored.receipt.legacyImports["auth:node"];
      owner.transaction(() =>
        writeClientCredentialReceipt(owner.database, stored.receipt, "complete"),
      );
    }
    const directory = path.join(fixture.root, "identity");
    fs.mkdirSync(directory, { recursive: true });
    const identityPath = path.join(directory, "device.json");
    const consumedAuthPath = path.join(directory, "device-auth.json");
    const obsolete = '{"obsolete":"already canonical or consumed"}';
    fs.writeFileSync(identityPath, obsolete);
    fs.writeFileSync(consumedAuthPath, obsolete);
    const sourcePath = path.join(directory, "node-device-auth.json");
    const source = JSON.stringify({
      version: 1,
      deviceId: fixture.identity.deviceId,
      tokens: {
        operator: {
          token: "synthetic-imported-token",
          scopes: ["operator.read"],
          updatedAtMs: 456,
        },
      },
    });
    fs.writeFileSync(sourcePath, source);
    await prepareStartupClientCredentials({ env: fixture.env, runtime, config: {} });
    expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toEqual(fixture.identity);
    expect(
      readDeviceAuthTokenForTest({
        env: fixture.env,
        deviceId: fixture.identity.deviceId,
        role: "operator",
      }),
    ).toMatchObject({
      token: "synthetic-imported-token",
      scopes: ["operator.read"],
      updatedAtMs: 456,
    });
    expect(
      readDeviceAuthTokenForTest({
        env: fixture.env,
        deviceId: fixture.identity.deviceId,
        role: "node",
      }),
    ).toEqual(fixture.token);
    expect(fs.readFileSync(identityPath, "utf8")).toBe(obsolete);
    expect(fs.readFileSync(consumedAuthPath, "utf8")).toBe(obsolete);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(source);
    using owner = openClientCredentialCustody(fixture.env, { readOnly: true })!;
    expect(
      readClientCredentialReceipt(owner.database)?.receipt.legacyImports["auth:node"],
    ).toBeDefined();
  });

  it("recovers an interrupted approvals hardlink claim during automatic preparation", async () => {
    const fixture = await bootstrap();
    const sourcePath = path.join(fixture.root, "exec-approvals.json");
    const claimPath = `${sourcePath}.doctor-importing`;
    const source = '{"defaults":{},"agents":{}}\n';
    fs.writeFileSync(sourcePath, source);
    fs.linkSync(sourcePath, claimPath);
    await prepareStartupClientCredentials({ env: fixture.env, runtime, config: {} });
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(claimPath)).toBe(false);
    const archives = fs
      .readdirSync(fixture.root)
      .filter((name) => name.startsWith("exec-approvals.json.migrated."));
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(path.join(fixture.root, archives[0]!), "utf8")).toBe(source);
    expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toEqual(fixture.identity);
  });

  it("leaves a fresh profile empty", async () => {
    const fixture = target();
    await prepareStartupClientCredentials({ env: fixture.env, runtime });
    expect(fs.readdirSync(fixture.root)).toEqual([]);
  });

  it("prepares admitted credentials without main-thread SQL, including restart", async () => {
    const fixture = await bootstrap();
    const sql = observeMainThreadSql();
    try {
      sql.calibrate();
      await prepareStartupClientCredentials({ env: fixture.env, runtime });
      sql.expectIdle();
      await closeOpenClawStateDatabaseAsync();
      sql.clear();
      await prepareStartupClientCredentials({ env: fixture.env, runtime });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toEqual(fixture.identity);
  });

  it("recovers a remounted fresh bootstrap without changing credentials or another root", async () => {
    const fixture = await bootstrap();
    const other = target();
    vi.stubEnv("OPENCLAW_STATE_DIR", other.root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", other.env.OPENCLAW_CONFIG_PATH);
    changeRecordedDevice(fixture.env);
    await prepareStartupClientCredentials({ env: fixture.env, runtime });
    expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toEqual(fixture.identity);
    expect(
      readDeviceAuthTokenForTest({
        env: fixture.env,
        deviceId: fixture.identity.deviceId,
        role: "node",
      }),
    ).toEqual(fixture.token);
    expect(fs.readdirSync(other.root)).toEqual([]);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(other.root);
    const bytes = fs.readFileSync(fixture.local);
    await prepareStartupClientCredentials({ env: fixture.env, runtime });
    expect(fs.readFileSync(fixture.local)).toEqual(bytes);
  });

  it("preserves the local credentials when the source generation does not match", async () => {
    const fixture = await bootstrap();
    changeRecordedDevice(fixture.env);
    {
      using source = new DatabaseSync(fixture.shared);
      source
        .prepare("UPDATE schema_meta SET created_at = created_at + 1 WHERE meta_key = 'primary'")
        .run();
    }
    const bytes = fs.readFileSync(fixture.local);
    await expect(prepareStartupClientCredentials({ env: fixture.env, runtime })).rejects.toThrow(
      ClientCredentialMigrationRequiredError,
    );
    expect(fs.readFileSync(fixture.local)).toEqual(bytes);
  });

  it("upgrades a healthy legacy bootstrap before its next filesystem remount", async () => {
    const fixture = await bootstrap();
    restoreLegacyBootstrapReceipt(fixture.env);
    await prepareStartupClientCredentials({ env: fixture.env, runtime });
    changeRecordedDevice(fixture.env);
    await prepareStartupClientCredentials({ env: fixture.env, runtime });
    expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toEqual(fixture.identity);
    expect(
      readDeviceAuthTokenForTest({
        env: fixture.env,
        deviceId: fixture.identity.deviceId,
        role: "node",
      }),
    ).toEqual(fixture.token);
  });

  it("keeps healthy legacy credentials readable while a Gateway owns shared state", async () => {
    const fixture = await bootstrap();
    restoreLegacyBootstrapReceipt(fixture.env);
    const before = fs.readFileSync(fixture.local);
    const serving = acquireGatewayStateOwner({
      databasePath: fixture.shared,
      payload: {
        pid: process.pid,
        processNamespace: readGatewayLockProcessNamespace(),
        role: "gateway",
        createdAt: new Date().toISOString(),
        configPath: fixture.env.OPENCLAW_CONFIG_PATH,
        stateDir: fixture.root,
      },
    });
    try {
      await prepareStartupClientCredentials({ env: fixture.env, runtime });
      expect(fs.readFileSync(fixture.local)).toEqual(before);
      expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toEqual(fixture.identity);
      expect(
        readDeviceAuthTokenForTest({
          env: fixture.env,
          deviceId: fixture.identity.deviceId,
          role: "node",
        }),
      ).toEqual(fixture.token);
    } finally {
      serving.release();
    }
  });

  it.each([
    { label: "readable credentials", required: false, recoveryPreview: false },
    { label: "required recovery", required: true, recoveryPreview: false },
    { label: "a validated config recovery preview", required: false, recoveryPreview: true },
  ])(
    "preserves offline PostgreSQL credentials with $label",
    async ({ required, recoveryPreview }) => {
      const reservation = await reserveTestPortListener({
        offsets: [0],
        createListener: () => net.createServer(),
      });
      await runQaGatewayFixture(
        async () => {
          await reservation.releaseListener();
          const fixture = await bootstrap(
            `postgresql://synthetic@127.0.0.1:${reservation.claim.port}/synthetic`,
          );
          const config: OpenClawConfig | undefined = recoveryPreview
            ? JSON.parse(fs.readFileSync(fixture.env.OPENCLAW_CONFIG_PATH, "utf8"))
            : undefined;
          if (recoveryPreview) {
            // The Gateway's recovery owner has selected this backup but has not applied it.
            fs.writeFileSync(fixture.env.OPENCLAW_CONFIG_PATH, '{"update":{"channel":"stable"}}');
          }
          const originalConfig = fs.readFileSync(fixture.env.OPENCLAW_CONFIG_PATH);
          restoreLegacyBootstrapReceipt(fixture.env);
          if (required) {
            changeRecordedDevice(fixture.env);
          }
          const before = fs.readFileSync(fixture.local);
          const error = vi.fn();
          const preparation = prepareStartupClientCredentials({
            env: fixture.env,
            runtime: { ...runtime, error },
            config,
          });
          if (required) {
            await expect(preparation).rejects.toThrow(/ECONNREFUSED/);
            expect(error).not.toHaveBeenCalled();
          } else {
            await expect(preparation).resolves.toBeUndefined();
            expect(error).toHaveBeenCalledWith(
              "Client credential metadata upgrade deferred; existing credentials remain available. Startup will retry automatically.",
            );
            expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toEqual(fixture.identity);
            expect(
              readDeviceAuthTokenForTest({
                env: fixture.env,
                deviceId: fixture.identity.deviceId,
                role: "node",
              }),
            ).toEqual(fixture.token);
          }
          expect(fs.readFileSync(fixture.local)).toEqual(before);
          expect(fs.readFileSync(fixture.env.OPENCLAW_CONFIG_PATH)).toEqual(originalConfig);
        },
        closeOpenClawStateDatabaseAsync,
        () => (reservation.listener.listening ? reservation.releaseListener() : undefined),
        reservation.claim.release,
      );
    },
  );

  it.each(["contention", "cleanup", "nested cleanup", "command cleanup", "cancellation"] as const)(
    "preserves %s outcome after another startup completes migration",
    async (failureKind) => {
      const fixture = await bootstrap();
      changeRecordedDevice(fixture.env);
      const contention = new GatewayStateOwnerContentionError(fixture.shared);
      const controller = new AbortController();
      const cleanup = new Error("Synthetic maintenance release failure");
      const aggregate = new AggregateError([contention, cleanup], "Admission cleanup failed");
      const failures = {
        contention: new Error("Maintenance admission refused", { cause: contention }),
        cleanup: aggregate,
        "nested cleanup": new Error("Maintenance admission failed", { cause: aggregate }),
        "command cleanup": new CommandProcessCleanupError({ cause: contention }),
        cancellation: new Error("Synthetic cancellation", { cause: contention }),
      };
      const failure = failures[failureKind];
      vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockImplementationOnce(async () => {
        // The peer performs real recovery; only the losing owner's failure is injected.
        await prepareStartupClientCredentials({ env: fixture.env, runtime });
        if (failureKind === "cancellation") {
          controller.abort(failure);
        }
        throw failure;
      });
      const preparation = withCommandProcessScope(
        () => prepareStartupClientCredentials({ env: fixture.env, runtime }),
        controller.signal,
      );
      if (failureKind === "contention") {
        await expect(preparation).resolves.toBeUndefined();
      } else {
        await expect(preparation).rejects.toBe(failure);
      }
      expect(loadDeviceIdentityIfPresent({ env: fixture.env })).toEqual(fixture.identity);
      expect(
        readDeviceAuthTokenForTest({
          env: fixture.env,
          deviceId: fixture.identity.deviceId,
          role: "node",
        }),
      ).toEqual(fixture.token);
    },
  );

  it("does not defer an optional upgrade after the local receipt becomes unreadable", async () => {
    const fixture = await bootstrap();
    restoreLegacyBootstrapReceipt(fixture.env);
    const refusal = new DoctorMaintenanceRefusalError("Synthetic admission refusal", {
      kind: "data-at-risk",
      reason: "gateway-state-unverified",
    });
    let refusedBytes: Buffer | undefined;
    vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockImplementationOnce(async () => {
      changeRecordedDevice(fixture.env);
      refusedBytes = fs.readFileSync(fixture.local);
      throw refusal;
    });
    await expect(prepareStartupClientCredentials({ env: fixture.env, runtime })).rejects.toBe(
      refusal,
    );
    expect(fs.readFileSync(fixture.local)).toEqual(refusedBytes);
  });

  it("does not replace missing SQLite credentials", async () => {
    const fixture = await bootstrap();
    fs.unlinkSync(fixture.local);
    await expect(prepareStartupClientCredentials({ env: fixture.env, runtime })).rejects.toThrow(
      ClientCredentialMigrationRequiredError,
    );
    expect(fs.existsSync(fixture.local)).toBe(false);
  });
});
