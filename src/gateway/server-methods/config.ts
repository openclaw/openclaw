import type { GatewayStartupCommand } from "../../config/types.gateway.js";
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
  writeConfigFile,
} from "../../config/config.js";
import { applyLegacyMigrations } from "../../config/legacy.js";
import { applyMergePatch } from "../../config/merge-patch.js";
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
  validateStartupCommandsAppendParams,
  validateStartupCommandsListParams,
  validateStartupCommandsRemoveParams,
} from "../protocol/index.js";

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

/**
 * Extract a value at a dot-notation path from an object.
 * Returns undefined if path doesn't exist.
 */
function getPathValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") {
    return undefined;
  }
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Extract a section from a JSON schema by navigating to properties.<section>.
 * Returns the sub-schema for that section, or undefined if not found.
 */
function getSchemaSection(schema: unknown, section: string): unknown {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const s = schema as Record<string, unknown>;
  const props = s.properties as Record<string, unknown> | undefined;
  if (!props) {
    return undefined;
  }
  return props[section];
}

/**
 * Extract schema at a dot-notation path.
 * Navigates through properties at each level.
 */
function getSchemaAtPath(schema: unknown, path: string): unknown {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const parts = path.split(".");
  let current: unknown = schema;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const c = current as Record<string, unknown>;
    const props = c.properties as Record<string, unknown> | undefined;
    if (!props) {
      return undefined;
    }
    current = props[part];
  }
  return current;
}

/**
 * Filter uiHints to only include hints for paths under the given prefix.
 */
function filterUiHints(hints: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const prefixDot = prefix + ".";
  for (const [key, value] of Object.entries(hints)) {
    if (key === prefix || key.startsWith(prefixDot)) {
      result[key] = value;
    }
  }
  return result;
}

function normalizeStartupCommandId(value: string, seen: Set<string>) {
  let base = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
  if (!base) {
    base = "startup";
  }
  let candidate = base;
  let counter = 1;
  while (seen.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  seen.add(candidate);
  return candidate;
}

function resolveStartupCommandEntries(commands: GatewayStartupCommand[]) {
  const seen = new Set<string>();
  const entries = commands.map((command, index) => {
    const baseId = command.id?.trim() || command.name?.trim() || `startup-${index + 1}`;
    const id = normalizeStartupCommandId(baseId, seen);
    return {
      ...command,
      id,
    };
  });
  return { entries, seen };
}

// Cache for config schema to avoid regenerating on every request.
// The schema only changes when plugins/channels are added, which requires a restart.
let cachedConfigSchema: {
  schema: unknown;
  uiHints: Record<string, unknown>;
  version: string;
  generatedAt: string;
} | null = null;

function getOrBuildConfigSchema(): NonNullable<typeof cachedConfigSchema> {
  if (cachedConfigSchema) {
    return cachedConfigSchema;
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
  cachedConfigSchema = buildConfigSchema({
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
  return cachedConfigSchema;
}

/** Clear cached schema (call on reload/restart). */
export function clearConfigSchemaCache() {
  cachedConfigSchema = null;
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

    const typedParams = params as { path?: string; section?: string; full?: boolean };
    const snapshot = await readConfigFileSnapshot();

    // If filtering is requested, extract the relevant portion
    if (typedParams.path) {
      const value = getPathValue(snapshot.config, typedParams.path);
      respond(
        true,
        {
          ...snapshot,
          config: value,
          raw: undefined, // Don't include raw when filtering
          filtered: { path: typedParams.path },
        },
        undefined,
      );
      return;
    }

    if (typedParams.section) {
      const config = snapshot.config as Record<string, unknown> | undefined;
      const value = config?.[typedParams.section];
      respond(
        true,
        {
          ...snapshot,
          config: value !== undefined ? { [typedParams.section]: value } : undefined,
          raw: undefined, // Don't include raw when filtering
          filtered: { section: typedParams.section },
        },
        undefined,
      );
      return;
    }

    // Return full snapshot (backwards compatible)
    respond(true, snapshot, undefined);
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

    const typedParams = params as {
      section?: string;
      path?: string;
      full?: boolean;
      ifNoneMatch?: string;
    };

    const fullSchema = getOrBuildConfigSchema();

    // Check if client already has current version (304-style caching)
    if (typedParams.ifNoneMatch && typedParams.ifNoneMatch === fullSchema.version) {
      respond(
        true,
        {
          notModified: true,
          version: fullSchema.version,
        },
        undefined,
      );
      return;
    }

    // If filtering by section
    if (typedParams.section) {
      const sectionSchema = getSchemaSection(fullSchema.schema, typedParams.section);
      if (sectionSchema === undefined) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown config section: ${typedParams.section}`),
        );
        return;
      }
      respond(
        true,
        {
          schema: sectionSchema,
          uiHints: filterUiHints(fullSchema.uiHints, typedParams.section),
          version: fullSchema.version,
          generatedAt: fullSchema.generatedAt,
          filtered: { section: typedParams.section },
        },
        undefined,
      );
      return;
    }

    // If filtering by path
    if (typedParams.path) {
      const pathSchema = getSchemaAtPath(fullSchema.schema, typedParams.path);
      if (pathSchema === undefined) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown config path: ${typedParams.path}`),
        );
        return;
      }
      respond(
        true,
        {
          schema: pathSchema,
          uiHints: filterUiHints(fullSchema.uiHints, typedParams.path),
          version: fullSchema.version,
          generatedAt: fullSchema.generatedAt,
          filtered: { path: typedParams.path },
        },
        undefined,
      );
      return;
    }

    // Return full schema (backwards compatible)
    respond(true, fullSchema, undefined);
  },
  "config.set": async ({ params, respond }) => {
    if (!validateConfigSetParams(params)) {
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
      return;
    }
    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config.set params: raw (string) required"),
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
    await writeConfigFile(validated.config);
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: validated.config,
      },
      undefined,
    );
  },
  "config.patch": async ({ params, respond }) => {
    if (!validateConfigPatchParams(params)) {
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
          "invalid config.patch params: raw (string) required",
        ),
      );
      return;
    }
    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }
    if (
      !parsedRes.parsed ||
      typeof parsedRes.parsed !== "object" ||
      Array.isArray(parsedRes.parsed)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config.patch raw must be an object"),
      );
      return;
    }
    const merged = applyMergePatch(snapshot.config, parsedRes.parsed);
    const migrated = applyLegacyMigrations(merged);
    const resolved = migrated.next ?? merged;
    const validated = validateConfigObjectWithPlugins(resolved);
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
    await writeConfigFile(validated.config);

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
        config: validated.config,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
  "gateway.startupCommands.list": async ({ params, respond }) => {
    if (!validateStartupCommandsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid gateway.startupCommands.list params: ${formatValidationErrors(
            validateStartupCommandsListParams.errors,
          )}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.exists) {
      respond(
        true,
        {
          ok: true,
          exists: false,
          hash: null,
          commands: [],
        },
        undefined,
      );
      return;
    }
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before listing commands"),
      );
      return;
    }
    const commands = snapshot.config?.gateway?.startupCommands ?? [];
    const { entries } = resolveStartupCommandEntries(commands);
    const hash = resolveConfigSnapshotHash(snapshot);
    respond(
      true,
      {
        ok: true,
        exists: true,
        hash,
        commands: entries,
      },
      undefined,
    );
  },
  "gateway.startupCommands.append": async ({ params, respond }) => {
    if (!validateStartupCommandsAppendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid gateway.startupCommands.append params: ${formatValidationErrors(
            validateStartupCommandsAppendParams.errors,
          )}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    if (snapshot.exists && !snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before appending commands"),
      );
      return;
    }
    const startupCommand = (params as { startupCommand?: GatewayStartupCommand }).startupCommand;
    if (!startupCommand || typeof startupCommand !== "object" || Array.isArray(startupCommand)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "gateway.startupCommands.append startupCommand must be an object",
        ),
      );
      return;
    }
    const baseConfig = snapshot.config ?? {};
    const gatewayConfig = baseConfig.gateway ?? {};
    const existingCommands = gatewayConfig.startupCommands ?? [];
    const { seen } = resolveStartupCommandEntries(existingCommands);
    const baseId =
      startupCommand.id?.trim() ||
      startupCommand.name?.trim() ||
      startupCommand.command?.trim() ||
      `startup-${existingCommands.length + 1}`;
    const id = normalizeStartupCommandId(baseId, seen);
    const nextCommands = [...existingCommands, { ...startupCommand, id }];
    const nextConfig = {
      ...baseConfig,
      gateway: {
        ...gatewayConfig,
        startupCommands: nextCommands,
      },
    };
    const migrated = applyLegacyMigrations(nextConfig);
    const resolved = migrated.next ?? nextConfig;
    const validated = validateConfigObjectWithPlugins(resolved);
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
    await writeConfigFile(validated.config);

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
        mode: "gateway.startupCommands.append",
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
      reason: "gateway.startupCommands.append",
    });
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: validated.config,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
  "gateway.startupCommands.remove": async ({ params, respond }) => {
    if (!validateStartupCommandsRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid gateway.startupCommands.remove params: ${formatValidationErrors(
            validateStartupCommandsRemoveParams.errors,
          )}`,
        ),
      );
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    if (!requireConfigBaseHash(params, snapshot, respond)) {
      return;
    }
    if (!snapshot.exists) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "no config found; cannot remove startup commands"),
      );
      return;
    }
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before removing commands"),
      );
      return;
    }
    const baseConfig = snapshot.config ?? {};
    const gatewayConfig = baseConfig.gateway ?? {};
    const existingCommands = gatewayConfig.startupCommands ?? [];
    const { entries } = resolveStartupCommandEntries(existingCommands);
    const requestedIdRaw = (params as { startupCommandId?: string }).startupCommandId?.trim() ?? "";
    if (!requestedIdRaw) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "startupCommandId must be a non-empty string"),
      );
      return;
    }
    const requestedId = normalizeStartupCommandId(requestedIdRaw, new Set());
    const matchIndex = entries.findIndex((entry) => entry.id === requestedId);
    if (matchIndex === -1) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `startup command not found: ${requestedId}`),
      );
      return;
    }
    const nextCommands = existingCommands.filter((_, index) => index !== matchIndex);
    const nextConfig = {
      ...baseConfig,
      gateway: {
        ...gatewayConfig,
        startupCommands: nextCommands,
      },
    };
    const migrated = applyLegacyMigrations(nextConfig);
    const resolved = migrated.next ?? nextConfig;
    const validated = validateConfigObjectWithPlugins(resolved);
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
    await writeConfigFile(validated.config);

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
        mode: "gateway.startupCommands.remove",
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
      reason: "gateway.startupCommands.remove",
    });
    respond(
      true,
      {
        ok: true,
        path: CONFIG_PATH,
        config: validated.config,
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
    await writeConfigFile(validated.config);

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
        config: validated.config,
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
