import type { OpenClawConfig } from "../config/types.openclaw.js";

export type CronInspectLinksMode = "always" | "errors" | "never";

/** Resolves the cron Control UI link policy while preserving the historical default. */
export function resolveCronInspectLinksMode(config: OpenClawConfig): CronInspectLinksMode {
  return config.cron?.announce?.inspectLinks ?? "always";
}

export function shouldIncludeCronInspectLink(
  config: OpenClawConfig,
  kind: "completion" | "error",
): boolean {
  const mode = resolveCronInspectLinksMode(config);
  return mode === "always" || (mode === "errors" && kind === "error");
}
