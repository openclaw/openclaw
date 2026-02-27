import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliDeps } from "../cli/deps.js";
import { resolveTenantStateDirFromId } from "../config/paths.js";
import { type TenantContext, runWithTenantContext } from "../config/tenant-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { GlobalExecutionPool } from "./execution-pool.js";
import { buildGatewayCronServiceForTenant, type GatewayCronState } from "./server-cron.js";

const log = createSubsystemLogger("cron-registry");

/**
 * CronServiceRegistry — Per-tenant CronService lifecycle manager.
 *
 * Lazily creates CronService instances for each tenant, starts them,
 * and provides shutdown/cleanup. At gateway startup, scans for existing
 * tenant data directories that have cron stores and starts their services.
 */
export class CronServiceRegistry {
  private readonly instances = new Map<string, GatewayCronState>();
  private readonly deps: CliDeps;
  private readonly broadcast: (
    event: string,
    payload: unknown,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  private readonly executionPool: GlobalExecutionPool | undefined;
  private stopped = false;

  constructor(params: {
    deps: CliDeps;
    broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
    executionPool?: GlobalExecutionPool;
  }) {
    this.deps = params.deps;
    this.broadcast = params.broadcast;
    this.executionPool = params.executionPool;
  }

  /**
   * Get or lazily create a CronService for the given tenant.
   * Starts the service immediately after creation.
   */
  getOrCreate(tenantCtx: TenantContext): GatewayCronState {
    if (this.stopped) {
      throw new Error("CronServiceRegistry is stopped");
    }

    const existing = this.instances.get(tenantCtx.tenantId);
    if (existing) {
      return existing;
    }

    return this.createForTenant(tenantCtx);
  }

  get(tenantId: string): GatewayCronState | undefined {
    return this.instances.get(tenantId);
  }

  /**
   * Scan existing tenant data directories and start CronServices
   * for any that have cron stores.
   */
  async startExisting(): Promise<void> {
    const defaultDir =
      process.platform === "darwin" ? path.join(os.homedir(), "data", "tenants") : "/data/tenants";
    const baseDir = process.env.TENANT_DATA_DIR?.trim() || defaultDir;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        log.info(`tenant data dir not found at ${baseDir}, skipping cron startup scan`);
        return;
      }
      throw err;
    }

    const tenantDirs = entries.filter((e) => e.isDirectory());
    let started = 0;

    for (const dir of tenantDirs) {
      const tenantId = dir.name;
      const stateDir = resolveTenantStateDirFromId(tenantId);
      const cronStorePath = path.join(stateDir, "cron", "jobs.json");

      try {
        await fs.promises.access(cronStorePath, fs.constants.F_OK);
      } catch {
        // No cron store for this tenant — skip
        continue;
      }

      if (this.instances.has(tenantId)) {
        continue;
      }

      const tenantCtx: TenantContext = { tenantId, stateDir };
      try {
        this.createForTenant(tenantCtx);
        started++;
      } catch (err) {
        log.warn(`failed to start cron for tenant ${tenantId}: ${String(err)}`);
      }
    }

    if (started > 0) {
      log.info(`started cron services for ${started} existing tenant(s)`);
    }
  }

  stopTenant(tenantId: string): void {
    const state = this.instances.get(tenantId);
    if (state) {
      state.cron.stop();
      this.instances.delete(tenantId);
    }
  }

  stopAll(): void {
    this.stopped = true;
    for (const [tenantId, state] of this.instances) {
      try {
        state.cron.stop();
      } catch (err) {
        log.warn(`failed to stop cron for tenant ${tenantId}: ${String(err)}`);
      }
    }
    this.instances.clear();
  }

  get size(): number {
    return this.instances.size;
  }

  private createForTenant(tenantCtx: TenantContext): GatewayCronState {
    // Build the CronService within the tenant's ALS context so that
    // loadConfig(), resolveCronStorePath(), etc. resolve to tenant paths.
    const state = runWithTenantContext(tenantCtx, () =>
      buildGatewayCronServiceForTenant({
        tenantCtx,
        deps: this.deps,
        broadcast: this.broadcast,
        executionPool: this.executionPool,
      }),
    );

    this.instances.set(tenantCtx.tenantId, state);

    // Start the timer (async, fire-and-forget)
    void state.cron.start().catch((err) => {
      log.warn(`failed to start cron for tenant ${tenantCtx.tenantId}: ${String(err)}`);
    });

    log.info(`cron service started for tenant ${tenantCtx.tenantId} (store: ${state.storePath})`);
    return state;
  }
}
