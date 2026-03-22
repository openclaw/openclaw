import { existsSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";

export function resolveConfiguredAcpBackendId(cfg: OpenClawConfig): string {
  return cfg.acp?.backend?.trim() || "acpx";
}

export function resolveAcpInstallCommandHint(cfg: OpenClawConfig): string {
  const configured = cfg.acp?.runtime?.installCommand?.trim();
  if (configured) {
    return configured;
  }
  const backendId = resolveConfiguredAcpBackendId(cfg).toLowerCase();
  if (backendId === "acpx") {
    const localPath = path.resolve(process.cwd(), "extensions/acpx");
    if (existsSync(localPath)) {
      return `openclaw plugins install ${localPath}`;
    }
    return "openclaw plugins install @openclaw/acpx-plugin";
  }
  return `Install and enable the plugin that provides ACP backend "${backendId}".`;
}
