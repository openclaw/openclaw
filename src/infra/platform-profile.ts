import os from "node:os";

export type ResourceProfile = "low" | "standard" | "high";

/**
 * Detects a resource profile based on available system memory.
 * Override with `OPENCLAW_RESOURCE_PROFILE` env var.
 */
export function detectResourceProfile(): ResourceProfile {
  const override = process.env.OPENCLAW_RESOURCE_PROFILE;
  if (override === "low" || override === "standard" || override === "high") {
    return override;
  }
  const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
  if (totalMB < 2048) {
    return "low";
  }
  if (totalMB < 8192) {
    return "standard";
  }
  return "high";
}

export function isArmDevice(): boolean {
  return process.arch === "arm64" || process.arch === "arm";
}

export function getRecommendedConcurrency(): number {
  const profile = detectResourceProfile();
  if (profile === "low") {
    return 1;
  }
  if (profile === "standard") {
    return 2;
  }
  return Math.max(1, Math.floor(os.cpus().length / 2));
}
