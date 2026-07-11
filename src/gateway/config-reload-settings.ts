// Gateway reload settings resolver.
// Normalizes reload mode and debounce config for watcher/reload handlers, and
// owns the shared hot-mode restart policy for restart-required config changes.
import type { GatewayReloadMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Path prefixes whose restart-required edits must never be deferred by the
 * hot-mode warn-and-keep contract. A live runtime that keeps the old token
 * after `gateway.auth.token` rotates is a credential-rotation-bypass risk:
 * the operator rotates on disk to respond to a leak, but the gateway
 * continues to accept the compromised token until manual restart.
 *
 * - `gateway.auth.*` covers the gateway access boundary itself (token,
 *   password, trusted-proxy headers).
 * - `auth.profiles.*` / `auth.order.*` cover model-auth profile routing at
 *   the config root. Doctor batch repairs rename stale profiles (for example
 *   `auth.profiles.openai-codex:*` -> `auth.profiles.openai:*`) alongside
 *   model routes; deferring the rename leaves the runtime authenticating
 *   through profiles that no longer exist on disk.
 * - `secrets.*` is deliberately excluded: provider SecretRef rotation is a
 *   supported live operation (the committed snapshot resolves the rotated
 *   ref without a restart), so escalating it here would replace live
 *   credential rotation with an avoidable gateway bounce (ClawSweeper P1
 *   #89517).
 *
 * The set is intentionally conservative; non-auth restart-required reasons
 * keep the shipped warn-and-keep contract. Operators who want blanket
 * auto-restart for restart-required edits use `gateway.reload.mode: "hybrid"`.
 */
// `secrets.*` is deliberately absent: provider secret rotation applies live
// through snapshot SecretRef resolution and must not trigger a restart.
const SECURITY_CRITICAL_RESTART_PREFIXES = ["gateway.auth", "auth.profiles", "auth.order"] as const;

function isSecurityCriticalRestartReason(reason: string): boolean {
  return SECURITY_CRITICAL_RESTART_PREFIXES.some(
    (prefix) => reason === prefix || reason.startsWith(`${prefix}.`),
  );
}

type HotModeRestartDecision = "security-critical" | "warn-and-keep";

/**
 * Shared hot-mode policy for restart-required config changes. The file
 * watcher (config-reload.ts) and the config.patch/config.apply RPC write path
 * (server-methods/config-write-flow.ts) both route through this decision so
 * the two write surfaces cannot diverge on when hot mode escalates a
 * restart-required change into an actual restart.
 */
export function resolveHotModeRestartDecision(
  restartReasons: readonly string[],
): HotModeRestartDecision {
  return restartReasons.some(isSecurityCriticalRestartReason)
    ? "security-critical"
    : "warn-and-keep";
}

type GatewayReloadSettings = {
  mode: GatewayReloadMode;
  debounceMs: number;
};

const DEFAULT_RELOAD_SETTINGS: GatewayReloadSettings = {
  mode: "hybrid",
  debounceMs: 300,
};

/** Resolves gateway reload mode/debounce from config with bounded defaults. */
export function resolveGatewayReloadSettings(cfg: OpenClawConfig): GatewayReloadSettings {
  const rawMode = cfg.gateway?.reload?.mode;
  const mode =
    rawMode === "off" || rawMode === "restart" || rawMode === "hot" || rawMode === "hybrid"
      ? rawMode
      : DEFAULT_RELOAD_SETTINGS.mode;
  return { mode, debounceMs: DEFAULT_RELOAD_SETTINGS.debounceMs };
}
