import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  buildConfiguredAllowlistKeys,
  modelKey,
  parseModelRef,
} from "../../agents/model-selection.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  CONFIG_PATH,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { applyLegacyMigrations } from "../../config/legacy.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { resolveAuditLogPath } from "../../config/paths.js";
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
import { AuditLogger } from "../audit.js";
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

/**
 * VD-7: Validate that the primary model in a config object is permitted by the
 * agents.defaults.models allowlist (if one is configured).
 *
 * Returns null if the model is allowed (or no allowlist is set), or an error
 * string describing the violation.
 */
function checkModelAllowlist(cfg: unknown): string | null {
  const agentDefaults = (cfg as { agents?: { defaults?: unknown } })?.agents?.defaults as
    | {
        models?: Record<string, unknown>;
        model?: { primary?: string } | string;
      }
    | undefined;

  if (!agentDefaults) {
    return null;
  }

  const allowlistKeys = buildConfiguredAllowlistKeys({
    cfg: cfg as Parameters<typeof buildConfiguredAllowlistKeys>[0]["cfg"],
    defaultProvider: DEFAULT_PROVIDER,
  });

  // No allowlist configured → allow any model
  if (!allowlistKeys) {
    return null;
  }

  // Resolve the primary model ref from the new config
  const rawModel = agentDefaults.model;
  const primaryRaw =
    typeof rawModel === "string"
      ? rawModel.trim()
      : typeof rawModel === "object" && rawModel !== null
        ? (rawModel.primary?.trim() ?? "")
        : "";

  if (!primaryRaw) {
    return null;
  } // No primary model set → nothing to enforce

  const parsed = parseModelRef(primaryRaw, DEFAULT_PROVIDER);
  if (!parsed) {
    return `invalid model reference: "${primaryRaw}"`;
  }

  const key = modelKey(parsed.provider, parsed.model);
  if (!allowlistKeys.has(key)) {
    const allowed = [...allowlistKeys].join(", ");
    return `model "${key}" is not in the agents.defaults.models allowlist. Allowed: ${allowed || "(none)"}`;
  }

  return null;
}

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

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond }) => {
    if (!validateConfigGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.get params: ${formatValidationErrors(validateConfigGetParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    respond(true, redactConfigSnapshot(snapshot), undefined);
  },
  "config.schema": ({ params, respond }) => {
    if (!validateConfigSchemaParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.schema params: ${formatValidationErrors(validateConfigSchemaParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const pluginRegistry = loadOpenClawPlugins({
      config: cfg,
      workspaceDir,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    });
    const schema = buildConfigSchema({
      plugins: pluginRegistry.plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        configUiHints: plugin.configUiHints,
        configSchema: plugin.configJsonSchema,
      })),
      channels: listChannelPlugins().map((entry) => ({
        id: entry.id,
        label: entry.meta.label,
        description: entry.meta.blurb,
        configSchema: entry.configSchema?.schema,
        configUiHints: entry.configSchema?.uiHints,
      })),
    });
    respond(true, schema, undefined);
  },
  "config.set": async ({ params, respond, client }) => {
    // Initialize audit logger (VD-2)
    const cfg = loadConfig();
    const auditLogger = new AuditLogger(resolveAuditLogPath(cfg));
    const deviceId = client?.connect?.device?.id;
    const clientIp: string | undefined = undefined; // not available in ConnectParams

    if (!validateConfigSetParams(params)) {
      // Audit failed validation
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.set",
          deviceId,
          clientIp,
          params: { validation_error: true },
          success: false,
          error: `invalid params: ${formatValidationErrors(validateConfigSetParams.errors)}`,
        })
        .catch(() => {}); // Don't fail request if audit fails

      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.set params: ${formatValidationErrors(validateConfigSetParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      // Audit base hash failure
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.set",
          deviceId,
          clientIp,
          params: { base_hash_error: true },
          success: false,
          error: "base hash mismatch or missing",
        })
        .catch(() => {});
      return;
    }
    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.set",
          deviceId,
          clientIp,
          params: { raw_type_error: true },
          success: false,
          error: "raw (string) required",
        })
        .catch(() => {});

      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config.set params: raw (string) required"),
      );
      return;
    }
    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.set",
          deviceId,
          clientIp,
          params: { parse_error: true },
          success: false,
          error: parsedRes.error,
        })
        .catch(() => {});

      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }
    const validated = validateConfigObjectWithPlugins(parsedRes.parsed);
    if (!validated.ok) {
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.set",
          deviceId,
          clientIp,
          params: { validation_error: true, issues: validated.issues },
          success: false,
          error: "invalid config",
        })
        .catch(() => {});

      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
          details: { issues: validated.issues },
        }),
      );
      return;
    }

    // VD-7: Enforce model allowlist — reject config that sets a primary model
    // outside the agents.defaults.models allowlist (if one is configured).
    const modelAllowlistError = checkModelAllowlist(validated.config);
    if (modelAllowlistError) {
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.set",
          deviceId,
          clientIp,
          params: { model_allowlist_violation: true },
          success: false,
          error: modelAllowlistError,
        })
        .catch(() => {});

      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, modelAllowlistError));
      return;
    }

    let restored: typeof validated.config;
    try {
      restored = restoreRedactedValues(
        validated.config,
        snapshot.config,
      ) as typeof validated.config;
    } catch (err) {
      const errorMsg = String(err instanceof Error ? err.message : err);
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.set",
          deviceId,
          clientIp,
          params: { restore_error: true },
          success: false,
          error: errorMsg,
        })
        .catch(() => {});

      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, errorMsg));
      return;
    }

    // Capture previous config for audit trail
    const previousConfig = snapshot.config;

    await writeConfigFile(restored);

    // Audit successful config.set (VD-2)
    await auditLogger
      .log({
        timestamp: new Date().toISOString(),
        method: "config.set",
        deviceId,
        clientIp,
        params: {
          changed_keys: Object.keys(restored).filter(
            (key) =>
              JSON.stringify((restored as Record<string, unknown>)[key]) !==
              JSON.stringify((previousConfig as Record<string, unknown> | undefined)?.[key]),
          ),
        },
        previous: previousConfig ? redactConfigObject(previousConfig) : undefined,
        success: true,
      })
      .catch(() => {}); // Don't fail request if audit fails

    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(restored),
      },
      undefined,
    );
  },
  "config.patch": async ({ params, respond, client }) => {
    // Initialize audit logger (VD-2)
    const cfg = loadConfig();
    const auditLogger = new AuditLogger(resolveAuditLogPath(cfg));
    const deviceId = client?.connect?.device?.id;
    const clientIp: string | undefined = undefined;

    if (!validateConfigPatchParams(params)) {
      // Audit failed validation
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.patch",
          deviceId,
          clientIp,
          params: { validation_error: true },
          success: false,
          error: `invalid params: ${formatValidationErrors(validateConfigPatchParams.errors)}`,
        })
        .catch(() => {});

      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.patch params: ${formatValidationErrors(validateConfigPatchParams.errors)}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      // Audit base hash failure
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.patch",
          deviceId,
          clientIp,
          params: { base_hash_error: true },
          success: false,
          error: "base hash mismatch or missing",
        })
        .catch(() => {});
      return;
    }
    if (!snapshot.valid) {
      // Audit invalid config
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.patch",
          deviceId,
          clientIp,
          params: { invalid_config: true },
          success: false,
          error: "invalid config; fix before patching",
        })
        .catch(() => {});

      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"),
      );
      return;
    }
    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      // Audit raw type error
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.patch",
          deviceId,
          clientIp,
          params: { raw_type_error: true },
          success: false,
          error: "raw (string) required",
        })
        .catch(() => {});

      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid config.patch params: raw (string) required",
        ),
      );
      return;
    }
    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      // Audit parse error
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.patch",
          deviceId,
          clientIp,
          params: { parse_error: true },
          success: false,
          error: parsedRes.error,
        })
        .catch(() => {});

      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }
    if (
      !parsedRes.parsed ||
      typeof parsedRes.parsed !== "object" ||
      Array.isArray(parsedRes.parsed)
    ) {
      // Audit object type error
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.patch",
          deviceId,
          clientIp,
          params: { object_type_error: true },
          success: false,
          error: "config.patch raw must be an object",
        })
        .catch(() => {});

      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config.patch raw must be an object"),
      );
      return;
    }
    const merged = applyMergePatch(snapshot.config, parsedRes.parsed);
    let restoredMerge: unknown;
    try {
      restoredMerge = restoreRedactedValues(merged, snapshot.config);
    } catch (err) {
      // Audit restore error
      const errorMsg = String(err instanceof Error ? err.message : err);
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.patch",
          deviceId,
          clientIp,
          params: { restore_error: true },
          success: false,
          error: errorMsg,
        })
        .catch(() => {});

      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String(err instanceof Error ? err.message : err)),
      );
      return;
    }
    const migrated = applyLegacyMigrations(restoredMerge);
    const resolved = migrated.next ?? restoredMerge;
    const validated = validateConfigObjectWithPlugins(resolved);
    if (!validated.ok) {
      // Audit validation error
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.patch",
          deviceId,
          clientIp,
          params: { validation_error: true, issues: validated.issues },
          success: false,
          error: "invalid config",
        })
        .catch(() => {});

      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
          details: { issues: validated.issues },
        }),
      );
      return;
    }

    // VD-7: Enforce model allowlist (same as config.set)
    const modelAllowlistError = checkModelAllowlist(validated.config);
    if (modelAllowlistError) {
      await auditLogger
        .log({
          timestamp: new Date().toISOString(),
          method: "config.patch",
          deviceId,
          clientIp,
          params: { model_allowlist_violation: true },
          success: false,
          error: modelAllowlistError,
        })
        .catch(() => {});

      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, modelAllowlistError));
      return;
    }

    // Capture previous config for audit trail
    const previousConfig = snapshot.config;

    await writeConfigFile(validated.config);

    // Audit successful config.patch (VD-2)
    await auditLogger
      .log({
        timestamp: new Date().toISOString(),
        method: "config.patch",
        deviceId,
        clientIp,
        params: {
          changed_keys: Object.keys(validated.config).filter(
            (key) =>
              JSON.stringify((validated.config as Record<string, unknown>)[key]) !==
              JSON.stringify((previousConfig as Record<string, unknown> | undefined)?.[key]),
          ),
        },
        previous: previousConfig ? redactConfigObject(previousConfig) : undefined,
        success: true,
      })
      .catch(() => {});

    const sessionKey =
      typeof (params as { sessionKey?: unknown }).sessionKey === "string"
        ? (params as { sessionKey?: string }).sessionKey?.trim() || undefined
        : undefined;
    const note =
      typeof (params as { note?: unknown }).note === "string"
        ? (params as { note?: string }).note?.trim() || undefined
        : undefined;
    const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;
    const restartDelayMs =
      typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw)
        ? Math.max(0, Math.floor(restartDelayMsRaw))
        : undefined;

    const payload: RestartSentinelPayload = {
      kind: "config-apply",
      status: "ok",
      ts: Date.now(),
      sessionKey,
      message: note ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: "config.patch",
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
      reason: "config.patch",
    });
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(validated.config),
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
  "config.apply": async ({ params, respond }) => {
    if (!validateConfigApplyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid config.apply params: ${formatValidationErrors(validateConfigApplyParams.errors)}`,
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
          "invalid config.apply params: raw (string) required",
        ),
      );
      return;
    }
    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }
    const validated = validateConfigObjectWithPlugins(parsedRes.parsed);
    if (!validated.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config", {
          details: { issues: validated.issues },
        }),
      );
      return;
    }
    let restoredApply: typeof validated.config;
    try {
      restoredApply = restoreRedactedValues(
        validated.config,
        snapshot.config,
      ) as typeof validated.config;
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, String(err instanceof Error ? err.message : err)),
      );
      return;
    }
    await writeConfigFile(restoredApply);

    const sessionKey =
      typeof (params as { sessionKey?: unknown }).sessionKey === "string"
        ? (params as { sessionKey?: string }).sessionKey?.trim() || undefined
        : undefined;
    const note =
      typeof (params as { note?: unknown }).note === "string"
        ? (params as { note?: string }).note?.trim() || undefined
        : undefined;
    const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;
    const restartDelayMs =
      typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw)
        ? Math.max(0, Math.floor(restartDelayMsRaw))
        : undefined;

    const payload: RestartSentinelPayload = {
      kind: "config-apply",
      status: "ok",
      ts: Date.now(),
      sessionKey,
      message: note ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: "config.apply",
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
      reason: "config.apply",
    });
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: redactConfigObject(restoredApply),
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
