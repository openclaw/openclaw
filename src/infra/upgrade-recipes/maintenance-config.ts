import type { ReadConfigFileSnapshotWithPluginMetadataResult } from "../../config/io.js";
import { stableConfigStringify } from "../../config/runtime-config-snapshot-match.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../crypto-digest.js";

function reject(message: string): never {
  throw new Error(`Gateway plugin-free upgrade maintenance refused: ${message}`);
}

/** Refusal preserves authored policy; it never silently disables required integrations. */
export function assertGatewayPluginFreeMaintenanceConfig(cfg: OpenClawConfig): void {
  if (
    cfg.plugins?.enabled !== false ||
    Object.values(cfg.plugins.entries ?? {}).some((entry) => entry.enabled === true)
  ) {
    reject("plugins must be explicitly disabled by the approved configuration");
  }
  if (
    cfg.channels &&
    Object.values(cfg.channels).some(
      (channel) =>
        channel && typeof channel === "object" && "enabled" in channel && channel.enabled !== false,
    )
  ) {
    reject("enabled channels are not qualified");
  }
  if (
    cfg.channels &&
    Object.values(cfg.channels).some(
      (channel) => channel && typeof channel === "object" && !("enabled" in channel),
    )
  ) {
    reject("channel activation must be explicitly disabled");
  }
  if (cfg.hooks && cfg.hooks.enabled !== false) {
    reject("hooks must be explicitly disabled");
  }
  if (cfg.mcp && Object.keys(cfg.mcp).length > 0) {
    reject("MCP integrations are not qualified");
  }
  if (Object.keys(cfg.models?.providers ?? {}).length > 0) {
    reject("custom provider initialization is not qualified");
  }
  if (cfg.secrets?.egressProxy?.enabled === true) {
    reject("secret egress proxy startup is not qualified");
  }
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    if ("source" in value && value.source === "exec") {
      reject("executable secret providers are not read-only initialization");
    }
    for (const child of Object.values(value)) {
      inspect(child);
    }
  };
  inspect(cfg);
}

/** Capture these facts in the approved plan, not from a recovery receipt. */
export function resolveGatewayUpgradeMaintenanceConfigIdentity(
  snapshot: Pick<
    ReadConfigFileSnapshotWithPluginMetadataResult["snapshot"],
    "hash" | "sourceConfig"
  >,
): { configHash: string; configSourceDigest: string } {
  if (!snapshot.hash || !/^[a-f0-9]{64}$/u.test(snapshot.hash)) {
    reject("the approved config revision is unavailable");
  }
  return {
    configHash: snapshot.hash,
    configSourceDigest: sha256Hex(stableConfigStringify(snapshot.sourceConfig)),
  };
}
