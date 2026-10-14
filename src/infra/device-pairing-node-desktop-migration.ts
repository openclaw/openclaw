// Preserve shipped Gateway opt-outs while moving desktop access to pairing approval.
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import {
  persistDevicePairingStoreState,
  readDevicePairingStoreStateFromDatabase,
} from "./device-pairing-store.js";
import {
  clearNodePairingGenerationState,
  resolveNodePairingGeneration,
  type PairedDevice,
} from "./device-pairing.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { recordLegacyMigrationRun } from "./state-migrations.receipts.js";

const MIGRATION_ID = "node-desktop-stream-pairing-defaults-v1";

/** Also applies to old file-backed surfaces imported after the SQLite migration completed. */
export function preserveLegacyDesktopStreamOptOut(
  device: PairedDevice,
  cfg: OpenClawConfig,
  now: number,
): boolean {
  const commands = cfg.gateway?.nodes?.commands;
  if (
    [commands?.allow, commands?.deny].some((entries) =>
      entries?.some((command) => command.trim() === NODE_DESKTOP_STREAM_COMMAND),
    )
  ) {
    return false;
  }
  const surface = device.nodeSurface;
  if (
    !Array.isArray(surface?.commands) ||
    !surface.commands.some(
      (command) => typeof command === "string" && command.trim() === NODE_DESKTOP_STREAM_COMMAND,
    )
  ) {
    return false;
  }
  if (
    !surface.commands.every((command) => typeof command === "string") ||
    !Number.isSafeInteger(surface.createdAtMs) ||
    !Number.isSafeInteger(surface.approvedAtMs) ||
    !Number.isSafeInteger(surface.approvedAtMs + 1)
  ) {
    throw new Error(`Cannot migrate malformed desktop approval for node ${device.deviceId}`);
  }
  const previousGeneration = resolveNodePairingGeneration(device);
  surface.commands = surface.commands.filter(
    (command) => command.trim() !== NODE_DESKTOP_STREAM_COMMAND,
  );
  surface.approvedAtMs = Math.max(now, surface.approvedAtMs + 1);
  clearNodePairingGenerationState(device, previousGeneration);
  if (
    device.pendingNodeSurface?.commands?.some(
      (command) => command.trim() === NODE_DESKTOP_STREAM_COMMAND,
    )
  ) {
    device.pendingNodeSurface.silent = false;
    device.pendingNodeSurface.revision = randomUUID();
  }
  return true;
}

/** Commit narrowed approvals and the once-per-database receipt together before node admission. */
export async function migrateLegacyDesktopStreamOptOuts(
  cfg: OpenClawConfig,
  baseDir?: string,
): Promise<number> {
  return await withDevicePairingLock(async () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const receipt = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<Pick<DB, "migration_runs">>(db)
            .selectFrom("migration_runs")
            .select("status")
            .where("id", "=", MIGRATION_ID),
        );
        if (receipt?.status === "completed") {
          return 0;
        }
        if (receipt) {
          throw new Error(
            "Desktop approval migration receipt is incomplete; existing approvals remain unchanged.",
          );
        }
        const now = Date.now();
        const state = readDevicePairingStoreStateFromDatabase(db);
        let retired = 0;
        for (const device of Object.values(state.pairedByDeviceId)) {
          if (preserveLegacyDesktopStreamOptOut(device, cfg, now)) {
            retired += 1;
          }
        }
        if (retired > 0) {
          persistDevicePairingStoreState(state, baseDir, "paired");
        }
        recordLegacyMigrationRun(db, {
          runId: MIGRATION_ID,
          startedAt: now,
          finishedAt: now,
          status: "completed",
          reportJson: JSON.stringify({ retiredDesktopApprovals: retired }),
        });
        return retired;
      },
      baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {},
      { operationLabel: "preserve legacy desktop stream opt-outs" },
    ),
  );
}
