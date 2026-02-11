/**
 * Enhanced config server methods with atomic configuration management
 * 
 * Extends the existing config methods with atomic operations, validation,
 * backup, rollback, and safe mode support.
 */

import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  CONFIG_PATH,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  validateConfigObjectWithPlugins,
} from "../../config/config.js";
import { applyLegacyMigrations } from "../../config/legacy.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import {
  redactConfigObject,
  redactConfigSnapshot,
  restoreRedactedValues,
} from "../../config/redact-snapshot.js";
import { buildConfigSchema } from "../../config/schema.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConfigApplyParams,
  validateConfigGetParams,
  validateConfigPatchParams,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "../protocol/index.js";
import { 
  getAtomicConfigManager,
  applyConfigAtomic,
  emergencyRecoverConfig,
  type AtomicConfigOptions 
} from "../../config/atomic-config.js";
import { 
  createSafeModeConfig,
  createSafeModeSentinel,
  removeSafeModeSentinel,
  isSafeModeEnabled,
  shouldStartInSafeMode,
  applySafeModeRestrictions,
  validateSafeModeConfig,
  logSafeModeActivation
} from "../../config/safe-mode.js";

// Re-export existing validation functions
function resolveBaseHash(params: unknown): string | null {
  const raw = (params as { baseHash?: unknown })?.baseHash;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash unavailable; re-run config.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHash(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash required; re-run config.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config changed since last load; re-run config.get and retry",
      ),
    );
    return false;
  }
  return true;
}

// Enhanced config handlers with atomic support
export const configAtomicHandlers: GatewayRequestHandlers = {
  // Enhanced config.apply with atomic operations
  "config.apply.atomic": async ({ params, respond }) => {
    if (!validateConfigApplyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.apply.atomic params: ${formatValidationErrors(validateConfigApplyParams.errors)}`,
        ),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }

    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid config.apply.atomic params: raw (string) required",
        ),
      );
      return;
    }

    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }

    let restoredApply: any;
    try {
      restoredApply = restoreRedactedValues(
        parsedRes.parsed,
        snapshot.config,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String(err instanceof Error ? err.message : err)),
      );
      return;
    }

    // Extract atomic options from params
    const sessionKey = (params as any).sessionKey?.trim() || undefined;
    const note = (params as any).note?.trim() || undefined;
    const restartDelayMs = typeof (params as any).restartDelayMs === "number" 
      ? Math.max(0, Math.floor((params as any).restartDelayMs))
      : undefined;
    const enableHealthCheck = (params as any).enableHealthCheck !== false;
    const healthCheckTimeoutMs = typeof (params as any).healthCheckTimeoutMs === "number"
      ? Math.max(5000, Math.floor((params as any).healthCheckTimeoutMs))
      : 30000;

    // Apply config atomically
    const atomicOptions: AtomicConfigOptions = {
      enableHealthCheck,
      healthCheckTimeoutMs,
    };

    const result = await applyConfigAtomic(restoredApply, note, atomicOptions);

    if (!result.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, result.error || "Atomic apply failed", {
          details: { 
            validationResult: result.validationResult,
            rolledBack: result.rolledBack,
            healthCheckPassed: result.healthCheckPassed,
          },
        }),
      );
      return;
    }

    // Create restart sentinel as in original implementation
    const payload: RestartSentinelPayload = {
      kind: "config-apply",
      status: "ok",
      ts: Date.now(),
      sessionKey,
      message: note ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: "config.apply.atomic",
        root: CONFIG_PATH,
      },
    };

    let sentinelPath: string | null = null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
    } catch {
      sentinelPath = null;
    }

    const restart = scheduleGatewaySigusr1Restart({
      delayMs: restartDelayMs,
      reason: "config.apply.atomic",
    });

    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(restoredApply),
        backupId: result.backupId,
        validationResult: result.validationResult,
        healthCheckPassed: result.healthCheckPassed,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },

  // Enhanced config.patch with atomic operations
  "config.patch.atomic": async ({ params, respond }) => {
    if (!validateConfigPatchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.patch.atomic params: ${formatValidationErrors(validateConfigPatchParams.errors)}`,
        ),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"),
      );
      return;
    }

    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid config.patch.atomic params: raw (string) required",
        ),
      );
      return;
    }

    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }

    if (!parsedRes.parsed || typeof parsedRes.parsed !== "object" || Array.isArray(parsedRes.parsed)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config.patch.atomic raw must be an object"),
      );
      return;
    }

    const merged = applyMergePatch(snapshot.config, parsedRes.parsed);
    let restoredMerge: unknown;
    try {
      restoredMerge = restoreRedactedValues(merged, snapshot.config);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String(err instanceof Error ? err.message : err)),
      );
      return;
    }

    const migrated = applyLegacyMigrations(restoredMerge);
    const resolved = migrated.next ?? restoredMerge;

    // Extract atomic options from params
    const sessionKey = (params as any).sessionKey?.trim() || undefined;
    const note = (params as any).note?.trim() || undefined;
    const restartDelayMs = typeof (params as any).restartDelayMs === "number" 
      ? Math.max(0, Math.floor((params as any).restartDelayMs))
      : undefined;
    const enableHealthCheck = (params as any).enableHealthCheck !== false;
    const healthCheckTimeoutMs = typeof (params as any).healthCheckTimeoutMs === "number"
      ? Math.max(5000, Math.floor((params as any).healthCheckTimeoutMs))
      : 30000;

    // Apply config atomically
    const atomicOptions: AtomicConfigOptions = {
      enableHealthCheck,
      healthCheckTimeoutMs,
    };

    const result = await applyConfigAtomic(resolved, note, atomicOptions);

    if (!result.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, result.error || "Atomic patch failed", {
          details: { 
            validationResult: result.validationResult,
            rolledBack: result.rolledBack,
            healthCheckPassed: result.healthCheckPassed,
          },
        }),
      );
      return;
    }

    // Create restart sentinel
    const payload: RestartSentinelPayload = {
      kind: "config-apply",
      status: "ok",
      ts: Date.now(),
      sessionKey,
      message: note ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: "config.patch.atomic",
        root: CONFIG_PATH,
      },
    };

    let sentinelPath: string | null = null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
    } catch {
      sentinelPath = null;
    }

    const restart = scheduleGatewaySigusr1Restart({
      delayMs: restartDelayMs,
      reason: "config.patch.atomic",
    });

    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(resolved),
        backupId: result.backupId,
        validationResult: result.validationResult,
        healthCheckPassed: result.healthCheckPassed,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },

  // Backup management
  "config.backup.create": async ({ params, respond }) => {
    try {
      const notes = typeof (params as any).notes === "string" ? (params as any).notes : undefined;
      const manager = getAtomicConfigManager();
      const backupId = await manager.createBackup(notes);
      
      respond(true, { backupId, notes }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to create backup: ${error}`),
      );
    }
  },

  "config.backup.list": async ({ params, respond }) => {
    try {
      const manager = getAtomicConfigManager();
      const backups = await manager.listBackups();
      
      respond(true, { backups }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to list backups: ${error}`),
      );
    }
  },

  "config.backup.rollback": async ({ params, respond }) => {
    const backupId = (params as any).backupId;
    if (typeof backupId !== "string") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "backupId (string) required"),
      );
      return;
    }

    try {
      const manager = getAtomicConfigManager();
      const result = await manager.rollback(backupId);
      
      if (result.success) {
        respond(
          true, 
          {
            ok: true,
            backupId,
            validationResult: result.validationResult,
            healthCheckPassed: result.healthCheckPassed,
          },
          undefined,
        );
      } else {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.error || "Rollback failed", {
            details: { 
              validationResult: result.validationResult,
              healthCheckPassed: result.healthCheckPassed,
            },
          }),
        );
      }
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Rollback failed: ${error}`),
      );
    }
  },

  // Emergency recovery
  "config.emergency.recover": async ({ params, respond }) => {
    try {
      const result = await emergencyRecoverConfig();
      
      if (result.success) {
        respond(
          true,
          {
            ok: true,
            backupId: result.backupId,
            validationResult: result.validationResult,
            healthCheckPassed: result.healthCheckPassed,
          },
          undefined,
        );
      } else {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, result.error || "Emergency recovery failed", {
            details: { validationResult: result.validationResult },
          }),
        );
      }
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Emergency recovery failed: ${error}`),
      );
    }
  },

  // Safe mode management
  "config.safemode.enable": async ({ params, respond }) => {
    try {
      const reason = typeof (params as any).reason === "string" ? (params as any).reason : undefined;
      await createSafeModeSentinel(reason);
      
      respond(true, { enabled: true, reason }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to enable safe mode: ${error}`),
      );
    }
  },

  "config.safemode.disable": async ({ params, respond }) => {
    try {
      await removeSafeModeSentinel();
      
      respond(true, { enabled: false }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to disable safe mode: ${error}`),
      );
    }
  },

  "config.safemode.status": ({ params, respond }) => {
    const envEnabled = isSafeModeEnabled();
    const shouldStart = shouldStartInSafeMode();
    const active = envEnabled || shouldStart;
    
    respond(
      true,
      {
        active,
        envEnabled,
        sentinelEnabled: shouldStart && !envEnabled,
      },
      undefined,
    );
  },

  "config.safemode.generate": ({ params, respond }) => {
    try {
      const options = (params as any).options || {};
      const safeModeConfig = createSafeModeConfig(options);
      
      respond(
        true,
        {
          config: redactConfigObject(safeModeConfig),
          options,
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Failed to generate safe mode config: ${error}`),
      );
    }
  },

  // Health check
  "config.health.check": async ({ params, respond }) => {
    try {
      const timeoutMs = typeof (params as any).timeoutMs === "number" 
        ? Math.max(5000, Math.floor((params as any).timeoutMs))
        : 30000;

      const manager = getAtomicConfigManager({ healthCheckTimeoutMs: timeoutMs });
      const healthy = await manager.performHealthCheck();
      
      respond(
        true,
        {
          healthy,
          timestamp: Date.now(),
          timeoutMs,
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Health check failed: ${error}`),
      );
    }
  },

  // Validation with 12-factor principles
  "config.validate.enhanced": async ({ params, respond }) => {
    try {
      const manager = getAtomicConfigManager();
      const snapshot = await readConfigFileSnapshot();
      const validation = await manager.validateConfig(snapshot.config);
      
      respond(
        true,
        {
          validation,
          timestamp: Date.now(),
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `Enhanced validation failed: ${error}`),
      );
    }
  },
};