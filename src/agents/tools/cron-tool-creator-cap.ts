import { readCronScheduledToolProjection } from "../exec-tool-target-pinning.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./cron-tool.types.js";

type NormalizedCronCreatorTool = Exclude<CronCreatorToolAllowlistEntry, string>;

type CronCreatorCapCaptureOptions = {
  /** Backend-projected native capabilities; must be exact vocabulary names. */
  canonicalToolNames?: readonly string[];
  /**
   * Restrict-only pin for a native `exec` entry. Set only by a caller that knows
   * the native shell ran on the Gateway host (the loopback grant path excludes
   * node placement); a harness that may run its shell remotely leaves it unset.
   */
  nativeExecTarget?: { host: "gateway" };
};

/**
 * Closed core-owned vocabulary a CLI backend may project its native tools into.
 * Anything else is a backend contract bug and fails closed at capture time so a
 * raw harness tool name can never become a persisted cron capability.
 */
const NATIVE_CRON_CREATOR_CAPABILITIES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "web_search",
  "web_fetch",
]);

/** Fails closed on any backend-projected name outside the exact canonical vocabulary. */
export function assertNativeCronCreatorCapabilities(names: readonly string[]): void {
  for (const name of names) {
    // Exact match, no trimming, case folding, or alias folding: a raw harness
    // name such as "Bash" must be projected by its backend, never accepted here.
    if (!NATIVE_CRON_CREATOR_CAPABILITIES.has(name)) {
      throw new Error(
        `cron creator authority rejected non-canonical native capability ${JSON.stringify(name)}`,
      );
    }
  }
}

/** Legacy SDK capture helper. Scheduled execution no longer replays this snapshot. */
export function replaceWithEffectiveCronCreatorToolAllowlist<T extends { name: string }>(
  target: CronCreatorToolAllowlistEntry[],
  tools: readonly T[],
  toolMeta?: (tool: T) => { pluginId?: string } | undefined,
  options: CronCreatorCapCaptureOptions = {},
): void {
  target.length = 0;
  // Host-created alias projections (for example a Codex gateway shell alias) are
  // recorded under their canonical core tool name so scheduled runtimes rebuild
  // the same capability. The alias name is kept for explicit-cap matching only.
  const captured = new Map<string, NormalizedCronCreatorTool>();
  for (const tool of tools) {
    const projection = readCronScheduledToolProjection(tool);
    const name = normalizeToolPolicyName(projection ? projection.targetTool : tool.name);
    if (!name) {
      continue;
    }
    const aliasName = projection ? normalizeToolPolicyName(tool.name) : undefined;
    const existing = captured.get(name);
    if (existing !== undefined) {
      // Merge duplicate grants of one canonical tool: alias names stay matchable,
      // and the restrict-only target survives only when every grantor pins it.
      if (aliasName && !existing.aliasName) {
        existing.aliasName = aliasName;
      }
      if (existing.execTarget && !projection?.execTarget) {
        delete existing.execTarget;
      } else if (
        existing.execTarget?.ask === "always" &&
        projection?.execTarget?.ask !== "always"
      ) {
        delete existing.execTarget.ask;
      }
      continue;
    }
    const meta = toolMeta?.(tool);
    const pluginId =
      typeof meta?.pluginId === "string" ? normalizeToolPolicyName(meta.pluginId) : undefined;
    captured.set(name, {
      name,
      ...(pluginId ? { pluginId } : {}),
      ...(aliasName && aliasName !== name ? { aliasName } : {}),
      ...(projection?.execTarget ? { execTarget: { ...projection.execTarget } } : {}),
    });
  }
  // Native harness tools do not have OpenClaw tool objects, so their trusted
  // runtime owner contributes canonical capability names at this same final seam.
  // The native shell is a different surface from a Gateway exec alias, so an
  // existing alias entry (and any target pin it carries) stays authoritative.
  assertNativeCronCreatorCapabilities(options.canonicalToolNames ?? []);
  for (const name of options.canonicalToolNames ?? []) {
    if (captured.has(name)) {
      continue;
    }
    captured.set(
      name,
      name === "exec" && options.nativeExecTarget
        ? { name, execTarget: { ...options.nativeExecTarget } }
        : { name },
    );
  }
  target.push(...captured.values());
}

/** Records the creator cap only after every runtime policy and schema quarantine has run. */
export function captureFinalEffectiveCronCreatorToolAllowlist<T extends { name: string }>(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly T[],
  toolMeta?: (tool: T) => { pluginId?: string } | undefined,
  options: CronCreatorCapCaptureOptions = {},
): void {
  replaceWithEffectiveCronCreatorToolAllowlist(target, tools, toolMeta, options);
  captureRef.value = { version: 1, source: "final-executable-surface" };
}
