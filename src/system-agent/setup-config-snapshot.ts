import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { shortenHomePath } from "../utils.js";

export function requireValidSystemAgentSetupSnapshot(snapshot: ConfigFileSnapshot): {
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
} {
  if (snapshot.exists && !snapshot.valid) {
    const issue = snapshot.issues?.[0];
    const detail = issue ? ` (${issue.path ? `${issue.path}: ` : ""}${issue.message})` : "";
    throw new Error(
      `OpenClaw config ${shortenHomePath(snapshot.path)} is invalid${detail}. Fix it before running setup.`,
    );
  }
  const sourceConfig = snapshot.exists ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const runtimeConfig = snapshot.exists ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  return { sourceConfig, runtimeConfig };
}
