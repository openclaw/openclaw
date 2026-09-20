import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  prepareGatewayRunBootstrap,
  recheckGatewayRunBootstrap,
} from "../cli/gateway-cli/pre-bootstrap.js";
import * as healthState from "../config/io.health-state.js";
import * as checkpoint from "../infra/startup-migration-checkpoint.js";
import { ExitError } from "../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

it("skips recovery health reads without a backup and admits a later backup", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const raw = JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, raw);
    openOpenClawStateDatabase({ path: path.join(stateDir, "state", "openclaw.sqlite") });
    closeOpenClawStateDatabaseForTest();
    const healthRead = vi.fn();
    const capture = healthState.captureConfigHealthStateStore;
    vi.spyOn(healthState, "captureConfigHealthStateStore").mockImplementation((...args) => {
      const store = capture(...args);
      return {
        ...store,
        read() {
          healthRead();
          return store.read();
        },
      };
    });
    const readiness = await import("../state/openclaw-database-preflight.js");
    const assertReady = vi.spyOn(readiness, "assertOpenClawDatabasesReady");
    const options = {
      migrateState: false,
      migrateLegacyConfig: false,
      requireStartupMigrationCheckpoint: true,
    };

    const first = await runDoctorConfigPreflight(options);

    expect(first.snapshot.valid).toBe(true);
    expect(assertReady).toHaveBeenCalled();
    expect(healthRead).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    await expect(fs.stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(`${configPath}.bak`, raw);
    await fs.writeFile(configPath, '{"update":{"channel":"stable"}}');
    const recovered = await runDoctorConfigPreflight(options);

    expect(healthRead).toHaveBeenCalled();
    expect(recovered.snapshot.valid).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    expect(checkpoint.hasActiveStartupMigrationLease()).toBe(false);
  });
});

it("restores the admitted backup after database readiness exceeds the lease TTL", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    const backup = { gateway: { mode: "local" }, plugins: { enabled: false } };
    await fs.writeFile(configPath, '{"update":{"channel":"stable"}}\n');
    await fs.writeFile(`${configPath}.bak`, JSON.stringify(backup));
    openOpenClawStateDatabase({ path: path.join(stateDir, "state", "openclaw.sqlite") });
    closeOpenClawStateDatabaseForTest();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    let acquired = false;
    let heartbeats = 0;
    const acquire = checkpoint.acquireStartupMigrationLeaseWithWait;
    vi.spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait").mockImplementationOnce(
      async (params) => {
        const lease = await acquire(params);
        const heartbeat = lease.heartbeat;
        vi.spyOn(lease, "heartbeat").mockImplementation((heartbeatParams) => {
          heartbeats++;
          heartbeat(heartbeatParams);
        });
        acquired = true;
        return lease;
      },
    );
    const readiness = await import("../state/openclaw-database-preflight.js");
    const assertReady = readiness.assertOpenClawDatabasesReady;
    let delayed = false;
    vi.spyOn(readiness, "assertOpenClawDatabasesReady").mockImplementation(async (params) => {
      await assertReady(params);
      if (acquired && !delayed) {
        delayed = true;
        // Keep the real admission promise pending while interval renewals become due.
        await vi.advanceTimersByTimeAsync(checkpoint.STARTUP_MIGRATION_LEASE_TTL_MS + 60_000);
      }
    });

    const result = await runDoctorConfigPreflight({
      migrateState: false,
      migrateLegacyConfig: false,
      requireStartupMigrationCheckpoint: true,
    });

    expect(delayed).toBe(true);
    expect(result.snapshot.valid).toBe(true);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(backup);
    expect(checkpoint.hasActiveStartupMigrationLease()).toBe(false);
    const completedHeartbeats = heartbeats;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeats).toBe(completedHeartbeats);
  });
});

it.each(["backup", "active config"] as const)(
  "refuses changed %s under the lease before any repair",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      const backup = { gateway: { mode: "local" }, plugins: { enabled: false } };
      const original =
        kind === "backup" ? '{"update":{"channel":"stable"}}\n' : JSON.stringify(backup);
      const replacement = JSON.stringify(
        kind === "backup"
          ? {
              ...backup,
              meta: { lastTouchedVersion: "9999.1.1" },
              env: { vars: { OPENCLAW_SERVICE_MARKER: "openclaw" } },
            }
          : {
              ...backup,
              agents: { defaults: { workspace: path.join(home, "changed-workspace") } },
            },
      );
      openOpenClawStateDatabase({ path: path.join(stateDir, "state", "openclaw.sqlite") });
      closeOpenClawStateDatabaseForTest();
      const stateMigration = await import("../infra/state-migrations.state-dir.js");
      const migrateStateDir = vi.spyOn(stateMigration, "autoMigrateLegacyStateDir");
      await fs.writeFile(configPath, original);
      if (kind === "backup") {
        await fs.writeFile(`${configPath}.bak`, JSON.stringify(backup));
      }
      const runtime = {
        log() {},
        error() {},
        exit(code: number): never {
          throw new ExitError(code);
        },
      };
      await withEnvAsync(
        { OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined },
        async () => {
          expect(await prepareGatewayRunBootstrap({ opts: {}, runtime })).toBe(true);
          const acquire = checkpoint.acquireStartupMigrationLeaseWithWait;
          vi.spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait").mockImplementationOnce(
            async (params) => {
              const lease = await acquire(params);
              await fs.writeFile(kind === "backup" ? `${configPath}.bak` : configPath, replacement);
              return lease;
            },
          );
          const refusal = await runDoctorConfigPreflight({
            migrateLegacyConfig: false,
            requireStartupMigrationCheckpoint: true,
            beforeStateMigrations: (snapshot) =>
              recheckGatewayRunBootstrap({ opts: {}, runtime, snapshot }),
          }).catch((error: unknown) => error);
          expect(migrateStateDir).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(0);
          expect(checkpoint.hasActiveStartupMigrationLease()).toBe(false);
          expect(refusal).toMatchObject({ code: kind === "backup" ? 78 : 1 });
          expect(await fs.readFile(configPath, "utf8")).toBe(
            kind === "backup" ? original : replacement,
          );
          expect(
            (await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered.")),
          ).toEqual([]);
        },
      );
    });
  },
);

it.each(["expired", "reassigned"] as const)(
  "does not restore a backup after the migration lease is %s during admission",
  async (loss) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      const original = '{"update":{"channel":"stable"}}\n';
      await fs.writeFile(configPath, original);
      await fs.writeFile(
        `${configPath}.bak`,
        JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
      );
      openOpenClawStateDatabase({ path: path.join(stateDir, "state", "openclaw.sqlite") });
      closeOpenClawStateDatabaseForTest();
      let replacement: checkpoint.StartupMigrationLease | undefined;
      vi.spyOn(checkpoint, "acquireStartupMigrationLeaseWithWait").mockImplementationOnce(
        async (params) => {
          const stale = checkpoint.acquireStartupMigrationLease({
            ...params,
            nowMs: Date.now() - checkpoint.STARTUP_MIGRATION_LEASE_TTL_MS - 1,
          });
          if (loss === "reassigned") {
            replacement = checkpoint.acquireStartupMigrationLease(params);
          }
          return stale;
        },
      );
      try {
        const refusal = await runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          requireStartupMigrationCheckpoint: true,
        }).catch((error: unknown) => error);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        expect((await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."))).toEqual(
          [],
        );
        expect(refusal).toBeInstanceOf(Error);
        expect(String(refusal)).toContain("startup migration lease was lost");
        expect(vi.getTimerCount()).toBe(0);
        replacement?.heartbeat();
      } finally {
        replacement?.release();
      }
    });
  },
);
