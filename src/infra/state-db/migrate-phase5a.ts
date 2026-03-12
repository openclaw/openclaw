/**
 * One-shot migration: Phase 5A device/node pairing JSON files → SQLite.
 *
 * Covers:
 *   ~/.openclaw/devices/pending.json → op1_device_pairing_pending rows
 *   ~/.openclaw/devices/paired.json  → op1_device_pairing_paired rows
 *   ~/.openclaw/nodes/pending.json   → op1_node_pairing_pending rows
 *   ~/.openclaw/nodes/paired.json    → op1_node_pairing_paired rows
 *
 * Each migrator is idempotent: skips if DB already has data.
 * Files are removed after migration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { DevicePairingPendingRequest, PairedDevice } from "../device-pairing.js";
import { loadJsonFile } from "../json-file.js";
import type { NodePairingPairedNode, NodePairingPendingRequest } from "../node-pairing.js";
import {
  getPairedDevicesFromDb,
  getPendingDevicePairingsFromDb,
  upsertPairedDeviceInDb,
  upsertPendingDevicePairingInDb,
} from "./device-pairing-sqlite.js";
import {
  getPairedNodesFromDb,
  getPendingNodePairingsFromDb,
  upsertPairedNodeInDb,
  upsertPendingNodePairingInDb,
} from "./node-pairing-sqlite.js";

type MigrationResult = {
  store: string;
  count: number;
  migrated: boolean;
  error?: string;
};

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// ── Device Pairing ─────────────────────────────────────────────────────────

function migrateDevicePairing(stateDir: string): MigrationResult {
  const result: MigrationResult = { store: "device-pairing", count: 0, migrated: false };
  const devicesDir = path.join(stateDir, "devices");
  const pendingPath = path.join(devicesDir, "pending.json");
  const pairedPath = path.join(devicesDir, "paired.json");

  try {
    const hasPendingFile = fs.existsSync(pendingPath);
    const hasPairedFile = fs.existsSync(pairedPath);

    if (!hasPendingFile && !hasPairedFile) {
      return result;
    }

    // Skip if DB already has data
    if (getPendingDevicePairingsFromDb().length > 0 || getPairedDevicesFromDb().length > 0) {
      tryUnlink(pendingPath);
      tryUnlink(pairedPath);
      return result;
    }

    if (hasPendingFile) {
      const raw = loadJsonFile(pendingPath) as Record<string, unknown> | null;
      if (raw && typeof raw === "object") {
        for (const req of Object.values(raw)) {
          if (!req || typeof req !== "object") {
            continue;
          }
          upsertPendingDevicePairingInDb(req as DevicePairingPendingRequest);
          result.count++;
        }
      }
      tryUnlink(pendingPath);
    }

    if (hasPairedFile) {
      const raw = loadJsonFile(pairedPath) as Record<string, unknown> | null;
      if (raw && typeof raw === "object") {
        for (const device of Object.values(raw)) {
          if (!device || typeof device !== "object") {
            continue;
          }
          upsertPairedDeviceInDb(device as PairedDevice);
          result.count++;
        }
      }
      tryUnlink(pairedPath);
    }

    if (result.count > 0) {
      result.migrated = true;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ── Node Pairing ────────────────────────────────────────────────────────────

function migrateNodePairing(stateDir: string): MigrationResult {
  const result: MigrationResult = { store: "node-pairing", count: 0, migrated: false };
  const nodesDir = path.join(stateDir, "nodes");
  const pendingPath = path.join(nodesDir, "pending.json");
  const pairedPath = path.join(nodesDir, "paired.json");

  try {
    const hasPendingFile = fs.existsSync(pendingPath);
    const hasPairedFile = fs.existsSync(pairedPath);

    if (!hasPendingFile && !hasPairedFile) {
      return result;
    }

    // Skip if DB already has data
    if (getPendingNodePairingsFromDb().length > 0 || getPairedNodesFromDb().length > 0) {
      tryUnlink(pendingPath);
      tryUnlink(pairedPath);
      return result;
    }

    if (hasPendingFile) {
      const raw = loadJsonFile(pendingPath) as Record<string, unknown> | null;
      if (raw && typeof raw === "object") {
        for (const req of Object.values(raw)) {
          if (!req || typeof req !== "object") {
            continue;
          }
          upsertPendingNodePairingInDb(req as NodePairingPendingRequest);
          result.count++;
        }
      }
      tryUnlink(pendingPath);
    }

    if (hasPairedFile) {
      const raw = loadJsonFile(pairedPath) as Record<string, unknown> | null;
      if (raw && typeof raw === "object") {
        for (const node of Object.values(raw)) {
          if (!node || typeof node !== "object") {
            continue;
          }
          upsertPairedNodeInDb(node as NodePairingPairedNode);
          result.count++;
        }
      }
      tryUnlink(pairedPath);
    }

    if (result.count > 0) {
      result.migrated = true;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function migratePhase5aToSqlite(env: NodeJS.ProcessEnv = process.env): MigrationResult[] {
  const stateDir = resolveStateDir(env, () => os.homedir());
  return [migrateDevicePairing(stateDir), migrateNodePairing(stateDir)];
}
