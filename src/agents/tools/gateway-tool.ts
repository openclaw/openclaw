import { isDeepStrictEqual } from "node:util";
import { Type } from "@sinclair/typebox";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { parseConfigJson5, resolveConfigSnapshotHash } from "../../config/io.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalString, readStringValue } from "../../shared/string-coerce.js";
import {
  createPluginActivationSource,
  normalizePluginsConfig,
  resolvePluginActivationState,
} from "../../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import { collectEnabledInsecureOrDangerousFlags } from "../../security/dangerous-config-flags.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions } from "./gateway.js";
import { isOpenClawOwnerOnlyCoreToolName } from "./owner-only-tools.js";
import { isRemoteGatewayTargetForAgentTools } from "./gateway.js";

const log = createSubsystemLogger("gateway-tool");

const DEFAULT_UPDATE_TIMEOUT_MS = 20 * 60_000;
const PROTECTED_GATEWAY_CONFIG_PATHS = [
  "tools.exec.ask",
  "tools.exec.security",
  "tools.exec.safeBins",
  "tools.exec.safeBinProfiles",
  "tools.exec.safeBinTrustedDirs",
  "tools.exec.strictInlineEval",
] as const;

function resolveBaseHashFromSnapshot(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const hashValue = (snapshot as { hash?: unknown }).hash;
  const rawValue = (snapshot as { raw?: unknown }).raw;
  const hash = resolveConfigSnapshotHash({
    hash: readStringValue(hashValue),
    raw: readStringValue(rawValue),
  });
  return hash ?? undefined;
}

function getSnapshotConfig(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("config.get response is not an object.");
  }
  const config = (snapshot as { config?: unknown }).config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config.get response is missing a config object.");
  }
  return config as Record<string, unknown>;
}

function parseGatewayConfigMutationRaw(
  raw: string,
  action: "config.apply" | "config.patch",
): unknown {
  const parsedRes = parseConfigJson5(raw);
  if (!parsedRes.ok) {
    throw new Error(parsedRes.error);
  }
  if (
    !parsedRes.parsed ||
    typeof parsedRes.parsed !== "object" ||
    Array.isArray(parsedRes.parsed)
  ) {
    throw new Error(`${action} raw must be an object.`);
  }
  return parsedRes.parsed;
}

function getValueAtCanonicalPath(config: Record<string, unknown>, path: string): unknown {
  let current: unknown = config;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function getValueAtPath(config: Record<string, unknown>, path: string): unknown {
  const direct = getValueAtCanonicalPath(config, path);
  if (direct !== undefined) {
    return direct;
  }
  if (!path.startsWith("tools.exec.")) {
    return undefined;
  }
  return getValueAtCanonicalPath(config, path.replace(/^tools\.exec\./, "tools.bash."));
}

function resolvePluginIdFromDangerousFlag(
  flag: string,
  config: Record<string, unknown>,
): string | undefined {
  // Use actual plugin entry keys so dotted IDs are handled correctly.
  // Take the longest matching prefix to avoid shorter IDs shadowing longer ones
  // when IDs share a prefix shape (e.g. "foo" and "foo.bar").
  const pluginEntries = (config as { plugins?: { entries?: Record<string, unknown> } }).plugins
    ?.entries;
  if (!pluginEntries) {
    return undefined;
  }
  let best: string | undefined;
  for (const id of Object.keys(pluginEntries)) {
    if (
      flag.startsWith(`plugins.entries.${id}.config.`) &&
      (best === undefined || id.length > best.length)
    ) {
      best = id;
    }
  }
  return best;
}

function isPluginEntryDangerousFlag(
  flag: string,
  config: Record<string, unknown>,
): flag is `plugins.entries.${string}.config.${string}` {
  return resolvePluginIdFromDangerousFlag(flag, config) !== undefined;
}

function getPluginIdFromDangerousFlag(
  flag: `plugins.entries.${string}.config.${string}`,
  config: Record<string, unknown>,
): string {
  return resolvePluginIdFromDangerousFlag(flag, config) ?? flag.split(".")[2] ?? "";
}

function isPluginDangerousFlagActive(
  config: Record<string, unknown>,
  flag: `plugins.entries.${string}.config.${string}`,
): boolean {
  const rootConfig = config as OpenClawConfig;
  const pluginId = getPluginIdFromDangerousFlag(flag, config);
  const pluginEntry = (rootConfig.plugins as { entries?: Record<string, unknown> } | undefined)
    ?.entries?.[pluginId];
  if (!pluginEntry || typeof pluginEntry !== "object" || Array.isArray(pluginEntry)) {
    return false;
  }
  const workspaceDir = resolveAgentWorkspaceDir(rootConfig, resolveDefaultAgentId(rootConfig));
  const manifestRecord = loadPluginManifestRegistry({
    config: rootConfig,
    workspaceDir,
    env: process.env,
    cache: true,
  }).plugins.find((plugin) => plugin.id === pluginId);
  if (!manifestRecord) {
    return (pluginEntry as { enabled?: unknown }).enabled !== false;
  }

  const normalizedPlugins = normalizePluginsConfig(rootConfig.plugins);
  const activationSource = createPluginActivationSource({
    config: rootConfig,
    plugins: normalizedPlugins,
  });
  return resolvePluginActivationState({
    id: pluginId,
    origin: manifestRecord.origin,
    config: normalizedPlugins,
    rootConfig,
    enabledByDefault: manifestRecord.enabledByDefault,
    activationSource,
  }).activated;
}

type DangerousFlagToken = {
  fingerprintIdentity?: string;
  legacyMappingIdentity?: string;
  idIdentity?: string;
  identities: string[];
  renderedFlag: string;
};

function toStableJsonWithoutKeys(value: unknown, keysToOmit: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => toStableJsonWithoutKeys(entry, keysToOmit));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => !keysToOmit.has(key))
      .toSorted()
      .map((key) => [key, toStableJsonWithoutKeys(record[key], keysToOmit)]),
  );
}

const HOOK_MAPPING_FINGERPRINT_OMIT_KEYS = new Set<string>(["id"]);
const HOOK_MAPPING_LEGACY_IDENTITY_OMIT_KEYS = new Set<string>([
  // Omit id so that gaining an id (or changing an existing id) does not shift the legacy
  // identity of an already-dangerous mapping. The id-match step in takeMatchingDangerousFlag
  // takes precedence for id-vs-id comparisons, so omitting id here does not enable a bypass.
  "id",
  "allowUnsafeExternalContent",
  "deliver",
  "messageTemplate",
  "name",
  "textTemplate",
  "thinking",
  "timeoutSeconds",
]);

function createDangerousConfigFlagToken(
  flag: string,
  config: Record<string, unknown>,
): DangerousFlagToken {
  const hookMatch = /^hooks\.mappings\[(\d+)\]\.(.+)$/.exec(flag);
  if (!hookMatch) {
    return { identities: [flag], renderedFlag: flag };
  }

  const [, indexStr, suffix] = hookMatch;
  const index = parseInt(indexStr, 10);
  const mappings = (config as { hooks?: { mappings?: unknown[] } }).hooks?.mappings;
  const identities = [`hooks.mappings[index=${index}].${suffix}`];
  if (!Array.isArray(mappings)) {
    return { identities, renderedFlag: flag };
  }

  const mapping = mappings[index];
  if (!mapping || typeof mapping !== "object") {
    return { identities, renderedFlag: flag };
  }

  let idIdentity: string | undefined;
  const id = (mapping as Record<string, unknown>).id;
  if (typeof id === "string" && id.trim()) {
    idIdentity = `hooks.mappings[id=${id}].${suffix}`;
    identities.unshift(idIdentity);
  }
  // Always compute legacyMappingIdentity for all hook mappings, not only id-less ones.
  // When a legacy (id-less) mapping gains an id in the same write that also changes a
  // non-routing field (e.g. textTemplate), the old token has legacyMappingIdentity but no
  // idIdentity, and the new token has idIdentity. Without legacyMappingIdentity on the new
  // token, neither the id-match nor the legacy-match steps in takeMatchingDangerousFlag fire;
  // fingerprint matching then fails (textTemplate changed), and the write is incorrectly
  // blocked as a newly enabled dangerous flag.
  const legacyMappingIdentity = `hooks.mappings[legacy=${JSON.stringify(toStableJsonWithoutKeys(mapping, HOOK_MAPPING_LEGACY_IDENTITY_OMIT_KEYS))}].${suffix}`;
  identities.push(legacyMappingIdentity);
  const fingerprintIdentity = `hooks.mappings[fingerprint=${JSON.stringify(toStableJsonWithoutKeys(mapping, HOOK_MAPPING_FINGERPRINT_OMIT_KEYS))}].${suffix}`;
  identities.unshift(fingerprintIdentity);
  return { fingerprintIdentity, legacyMappingIdentity, idIdentity, identities, renderedFlag: flag };
}

function takeMatchingDangerousFlag(
  remainingCurrentTokens: DangerousFlagToken[],
  nextToken: DangerousFlagToken,
): boolean {
  const matchIndex = remainingCurrentTokens.findIndex((currentToken) => {
    if (currentToken.idIdentity && nextToken.idIdentity) {
      return currentToken.idIdentity === nextToken.idIdentity;
    }
    if (currentToken.legacyMappingIdentity && nextToken.legacyMappingIdentity) {
      return currentToken.legacyMappingIdentity === nextToken.legacyMappingIdentity;
    }
    // When both tokens have a fingerprint (the mapping object existed in the config at tokenization
    // time), match by fingerprint only — not by index. This prevents a swap of one dangerous
    // mapping for a *different* dangerous mapping at the same array index from being treated as
    // "already present" just because the index-based identity strings overlap.
    if (currentToken.fingerprintIdentity && nextToken.fingerprintIdentity) {
      return currentToken.fingerprintIdentity === nextToken.fingerprintIdentity;
    }
    // Fallback for index-only tokens (mapping object was absent from config at tokenization time).
    return currentToken.identities.some((identity) => nextToken.identities.includes(identity));
  });
  if (matchIndex < 0) {
    return false;
  }
  remainingCurrentTokens.splice(matchIndex, 1);
  return true;
}

function collectNewlyEnabledDangerousConfigFlags(
  currentConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
): string[] {
  const currentFlags = collectEnabledInsecureOrDangerousFlags(currentConfig as OpenClawConfig);
  const remainingCurrentTokens = currentFlags.map((flag) =>
    createDangerousConfigFlagToken(flag, currentConfig),
  );
  // Honor the legacy tools.bash.applyPatch.workspaceOnly alias in the baseline so that
  // canonicalizing an already-dangerous legacy config to tools.exec.* is not treated as
  // a newly enabled dangerous flag.
  if (getValueAtPath(currentConfig, "tools.exec.applyPatch.workspaceOnly") === false) {
    const key = "tools.exec.applyPatch.workspaceOnly=false";
    if (
      !remainingCurrentTokens.some((token) =>
        token.identities.includes("tools.exec.applyPatch.workspaceOnly=false"),
      )
    ) {
      remainingCurrentTokens.push(createDangerousConfigFlagToken(key, currentConfig));
    }
  }
  const nextFlags = collectEnabledInsecureOrDangerousFlags(nextConfig as OpenClawConfig);
  const newlyEnabledFlags = nextFlags.filter(
    (flag) =>
      !takeMatchingDangerousFlag(
        remainingCurrentTokens,
        createDangerousConfigFlagToken(flag, nextConfig),
      ),
  );
  const currentActivePluginFlags = new Set(
    currentFlags.filter(
      (flag): flag is `plugins.entries.${string}.config.${string}` =>
        isPluginEntryDangerousFlag(flag, currentConfig) &&
        isPluginDangerousFlagActive(currentConfig, flag),
    ),
  );
  for (const flag of nextFlags) {
    if (
      !isPluginEntryDangerousFlag(flag, nextConfig) ||
      !isPluginDangerousFlagActive(nextConfig, flag)
    ) {
      continue;
    }
    if (currentActivePluginFlags.has(flag) || newlyEnabledFlags.includes(flag)) {
      continue;
    }
    newlyEnabledFlags.push(flag);
  }
  if (
    getValueAtPath(currentConfig, "tools.exec.applyPatch.workspaceOnly") !== false &&
    getValueAtPath(nextConfig, "tools.exec.applyPatch.workspaceOnly") === false &&
    !newlyEnabledFlags.includes("tools.exec.applyPatch.workspaceOnly=false")
  ) {
    newlyEnabledFlags.push("tools.exec.applyPatch.workspaceOnly=false");
  }
  return newlyEnabledFlags;
}

function assertGatewayConfigMutationAllowed(params: {
  action: "config.apply" | "config.patch";
  currentConfig: Record<string, unknown>;
  gatewayUrl?: string;
  raw: string;
}): void {
  const parsed = parseGatewayConfigMutationRaw(params.raw, params.action);
  const nextConfig =
    params.action === "config.apply"
      ? (parsed as Record<string, unknown>)
      : (applyMergePatch(params.currentConfig, parsed, {
          mergeObjectArraysById: true,
        }) as Record<string, unknown>);
  const changedProtectedPaths = PROTECTED_GATEWAY_CONFIG_PATHS.filter(
    (path) =>
      !isDeepStrictEqual(
        getValueAtPath(params.currentConfig, path),
        getValueAtPath(nextConfig, path),
      ),
  );
  if (changedProtectedPaths.length > 0) {
    throw new Error(
      `gateway ${params.action} cannot change protected config paths: ${changedProtectedPaths.join(", ")}`,
    );
  }
  // Load config fresh (not captured opts.config) so gateway.mode changes during a session are seen.
  if (isRemoteGatewayTargetForAgentTools({ gatewayUrl: params.gatewayUrl })) {
    // Check all plugin activation-related paths: entries, global enabled, allow/deny lists.
    // Any of these can activate plugins with dangerous host-specific config on a remote gateway.
    const REMOTE_PLUGIN_ACTIVATION_PATHS = [
      "plugins.entries",
      "plugins.enabled",
      "plugins.allow",
      "plugins.deny",
      "plugins.slots",
      // plugins.load.paths introduces new plugin manifests on the remote host; local contract
      // discovery cannot evaluate their dangerous flags, so block load-path changes remotely.
      "plugins.load",
      // channels.<id>.enabled activates bundled channel plugins via isBundledChannelEnabledByChannelConfig;
      // block channel config changes on remote gateways to close this activation path.
      "channels",
    ] as const;
    const changedActivationPaths = REMOTE_PLUGIN_ACTIVATION_PATHS.filter(
      (path) =>
        !isDeepStrictEqual(
          getValueAtCanonicalPath(params.currentConfig, path),
          getValueAtCanonicalPath(nextConfig, path),
        ),
    );
    if (changedActivationPaths.length > 0) {
      throw new Error(
        `gateway ${params.action} cannot change plugin config on remote gateways because dangerous plugin flags are host-specific`,
      );
    }
  }
  const newlyEnabledDangerousFlags = collectNewlyEnabledDangerousConfigFlags(
    params.currentConfig,
    nextConfig,
  );
  if (newlyEnabledDangerousFlags.length === 0) {
    return;
  }
  throw new Error(
    `gateway ${params.action} cannot enable dangerous config flags: ${newlyEnabledDangerousFlags.join(", ")}`,
  );
}

const GATEWAY_ACTIONS = [
  "restart",
  "config.get",
  "config.schema.lookup",
  "config.apply",
  "config.patch",
  "update.run",
] as const;

// NOTE: Using a flattened object schema instead of Type.Union([Type.Object(...), ...])
// because Claude API on Vertex AI rejects nested anyOf schemas as invalid JSON Schema.
// The discriminator (action) determines which properties are relevant; runtime validates.
const GatewayToolSchema = Type.Object({
  action: stringEnum(GATEWAY_ACTIONS),
  // restart
  delayMs: Type.Optional(Type.Number()),
  reason: Type.Optional(Type.String()),
  // config.get, config.schema.lookup, config.apply, update.run
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  // config.schema.lookup
  path: Type.Optional(Type.String()),
  // config.apply, config.patch
  raw: Type.Optional(Type.String()),
  baseHash: Type.Optional(Type.String()),
  // config.apply, config.patch, update.run
  sessionKey: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  restartDelayMs: Type.Optional(Type.Number()),
});
// NOTE: We intentionally avoid top-level `allOf`/`anyOf`/`oneOf` conditionals here:
// - OpenAI rejects tool schemas that include these keywords at the *top-level*.
// - Claude/Vertex has other JSON Schema quirks.
// Conditional requirements (like `raw` for config.apply) are enforced at runtime.

export function createGatewayTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Gateway",
    name: "gateway",
    ownerOnly: isOpenClawOwnerOnlyCoreToolName("gateway"),
    description:
      "Restart, inspect a specific config schema path, apply config, or update the gateway in-place (SIGUSR1). Use config.schema.lookup with a targeted dot path before config edits. Use config.patch for safe partial config updates (merges with existing). Use config.apply only when replacing entire config. Config writes hot-reload when possible and restart when required. Always pass a human-readable completion message via the `note` parameter so the system can deliver it to the user after restart.",
    parameters: GatewayToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      if (action === "restart") {
        if (!isRestartEnabled(opts?.config)) {
          throw new Error("Gateway restart is disabled (commands.restart=false).");
        }
        const sessionKey =
          normalizeOptionalString(params.sessionKey) ??
          normalizeOptionalString(opts?.agentSessionKey);
        const delayMs =
          typeof params.delayMs === "number" && Number.isFinite(params.delayMs)
            ? Math.floor(params.delayMs)
            : undefined;
        const reason = normalizeOptionalString(params.reason)?.slice(0, 200);
        const note = normalizeOptionalString(params.note);
        // Extract channel + threadId for routing after restart.
        // Uses generic :thread: parsing plus plugin-owned session grammars.
        const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
        const payload: RestartSentinelPayload = {
          kind: "restart",
          status: "ok",
          ts: Date.now(),
          sessionKey,
          deliveryContext,
          threadId,
          message: note ?? reason ?? null,
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: "gateway.restart",
            reason,
          },
        };
        try {
          await writeRestartSentinel(payload);
        } catch {
          // ignore: sentinel is best-effort
        }
        log.info(
          `gateway tool: restart requested (delayMs=${delayMs ?? "default"}, reason=${reason ?? "none"})`,
        );
        const scheduled = scheduleGatewaySigusr1Restart({
          delayMs,
          reason,
        });
        return jsonResult(scheduled);
      }

      const gatewayOpts = readGatewayCallOptions(params);

      const resolveGatewayWriteMeta = (): {
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      } => {
        const sessionKey =
          normalizeOptionalString(params.sessionKey) ??
          normalizeOptionalString(opts?.agentSessionKey);
        const note = normalizeOptionalString(params.note);
        const restartDelayMs =
          typeof params.restartDelayMs === "number" && Number.isFinite(params.restartDelayMs)
            ? Math.floor(params.restartDelayMs)
            : undefined;
        return { sessionKey, note, restartDelayMs };
      };

      const resolveConfigWriteParams = async (): Promise<{
        raw: string;
        baseHash: string;
        snapshotConfig: Record<string, unknown>;
        sessionKey: string | undefined;
        note: string | undefined;
        restartDelayMs: number | undefined;
      }> => {
        const raw = readStringParam(params, "raw", { required: true });
        const snapshot = await callGatewayTool("config.get", gatewayOpts, {});
        // Always fetch config.get so we can compare protected exec settings
        // against the current snapshot before forwarding any write RPC.
        const snapshotConfig = getSnapshotConfig(snapshot);
        let baseHash = readStringParam(params, "baseHash");
        if (!baseHash) {
          baseHash = resolveBaseHashFromSnapshot(snapshot);
        }
        if (!baseHash) {
          throw new Error("Missing baseHash from config snapshot.");
        }
        return { raw, baseHash, snapshotConfig, ...resolveGatewayWriteMeta() };
      };

      if (action === "config.get") {
        const result = await callGatewayTool("config.get", gatewayOpts, {});
        return jsonResult({ ok: true, result });
      }
      if (action === "config.schema.lookup") {
        const path = readStringParam(params, "path", {
          required: true,
          label: "path",
        });
        const result = await callGatewayTool("config.schema.lookup", gatewayOpts, { path });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.apply") {
        const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        assertGatewayConfigMutationAllowed({
          action: "config.apply",
          currentConfig: snapshotConfig,
          gatewayUrl: gatewayOpts.gatewayUrl,
          raw,
        });
        const result = await callGatewayTool("config.apply", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "config.patch") {
        const { raw, baseHash, snapshotConfig, sessionKey, note, restartDelayMs } =
          await resolveConfigWriteParams();
        assertGatewayConfigMutationAllowed({
          action: "config.patch",
          currentConfig: snapshotConfig,
          gatewayUrl: gatewayOpts.gatewayUrl,
          raw,
        });
        const result = await callGatewayTool("config.patch", gatewayOpts, {
          raw,
          baseHash,
          sessionKey,
          note,
          restartDelayMs,
        });
        return jsonResult({ ok: true, result });
      }
      if (action === "update.run") {
        const { sessionKey, note, restartDelayMs } = resolveGatewayWriteMeta();
        const updateTimeoutMs = gatewayOpts.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
        const updateGatewayOpts = {
          ...gatewayOpts,
          timeoutMs: updateTimeoutMs,
        };
        const result = await callGatewayTool("update.run", updateGatewayOpts, {
          sessionKey,
          note,
          restartDelayMs,
          timeoutMs: updateTimeoutMs,
        });
        return jsonResult({ ok: true, result });
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
