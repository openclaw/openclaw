/**
 * Memory Tier Service
 *
 * Background service that orchestrates tier transitions:
 *   T1→T2 compression → T3→T2 promotion → T2→T3 archival → T3 deletion → daily cleanup
 *
 * Guarded by a `running` flag to prevent concurrent cycles. Checks timestamps
 * to skip if no work is due, so overhead is near-zero per heartbeat.
 */

import type { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedTierConfig } from "./tier-types.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveTierConfig } from "./tier-config.js";
import { cleanupCompressedDailyFiles, compressDailyToShortTerm } from "./tier-compression.js";
import {
  archiveShortTermToLongTerm,
  promoteToShortTerm,
  purgeLongTermMemories,
} from "./tier-archival.js";

const log = createSubsystemLogger("memory/tier-service");

const MIN_CYCLE_INTERVAL_MS = 5 * 60 * 1000; // At most once every 5 minutes

export class MemoryTierService {
  private running = false;
  private lastCycleMs = 0;
  private readonly cfg: OpenClawConfig;
  private readonly agentId: string;

  constructor(params: { cfg: OpenClawConfig; agentId: string }) {
    this.cfg = params.cfg;
    this.agentId = params.agentId;
  }

  /**
   * Run a single maintenance cycle. Safe to call frequently —
   * skips if another cycle is in progress or if too soon since last run.
   */
  async runCycle(params?: {
    db?: DatabaseSync;
    callLlm?: (p: { prompt: string; system: string; model?: string }) => Promise<string>;
  }): Promise<void> {
    if (this.running) {
      return;
    }

    const now = Date.now();
    if (now - this.lastCycleMs < MIN_CYCLE_INTERVAL_MS) {
      return;
    }

    const tierConfig = this.resolveTierConfig();
    if (!tierConfig.enabled) {
      return;
    }

    this.running = true;
    this.lastCycleMs = now;

    try {
      const workspaceDir = resolveAgentWorkspaceDir(this.cfg, this.agentId);
      const db = params?.db;
      if (!db) {
        log.debug("tier-service: no db provided, skipping cycle");
        return;
      }

      // 1. T1→T2 compression
      if (params?.callLlm) {
        try {
          const compressed = await compressDailyToShortTerm({
            workspaceDir,
            db,
            tierConfig,
            cfg: this.cfg,
            callLlm: params.callLlm,
          });
          if (compressed > 0) {
            log.debug(`tier-service: compressed ${compressed} topic(s) T1→T2`);
          }
        } catch (err) {
          log.warn(
            `tier-service: T1→T2 compression failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 2. T3→T2 promotion (recall-based)
      try {
        const promoted = await promoteToShortTerm({
          workspaceDir,
          db,
          tierConfig,
        });
        if (promoted > 0) {
          log.debug(`tier-service: promoted ${promoted} file(s) T3→T2`);
        }
      } catch (err) {
        log.warn(
          `tier-service: T3→T2 promotion failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 3. T2→T3 archival
      try {
        const archived = await archiveShortTermToLongTerm({
          workspaceDir,
          db,
          tierConfig,
        });
        if (archived > 0) {
          log.debug(`tier-service: archived ${archived} file(s) T2→T3`);
        }
      } catch (err) {
        log.warn(
          `tier-service: T2→T3 archival failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 4. T3 deletion
      try {
        const purged = await purgeLongTermMemories({
          workspaceDir,
          db,
          tierConfig,
        });
        if (purged > 0) {
          log.debug(`tier-service: purged ${purged} file(s) from T3`);
        }
      } catch (err) {
        log.warn(
          `tier-service: T3 deletion failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 5. Daily cleanup (remove compressed daily files after 7 days)
      try {
        const cleaned = await cleanupCompressedDailyFiles({
          workspaceDir,
          db,
        });
        if (cleaned > 0) {
          log.debug(`tier-service: cleaned up ${cleaned} compressed daily file(s)`);
        }
      } catch (err) {
        log.warn(
          `tier-service: daily cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      this.running = false;
    }
  }

  private resolveTierConfig(): ResolvedTierConfig {
    const defaults = this.cfg.agents?.defaults?.memorySearch;
    return resolveTierConfig(defaults);
  }
}
