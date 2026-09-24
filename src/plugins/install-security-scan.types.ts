// Defines plugin install security scan result types.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstallPolicyFinding } from "../security/install-policy.js";

/** Skill install metadata shape passed into shared install policy evaluation. */
export type SkillInstallSpecMetadata = {
  id?: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  sha256?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
};

export type InstallPolicyWarningDetails = {
  targetName: string;
  targetType: "skill" | "plugin";
  requestMode: "install" | "update";
  reason: string;
  findings?: InstallPolicyFinding[];
};

export type InstallPolicyWarningAcknowledgementRequest = InstallPolicyWarningDetails;

type InstallPolicyWarningAcknowledgementResult = { status: "approved" } | { status: "declined" };

/** Overrides that intentionally loosen install safety policy for trusted/operator paths. */
export type InstallSafetyOverrides = {
  config?: OpenClawConfig;
  onInstallPolicyWarning?: (
    request: InstallPolicyWarningAcknowledgementRequest,
  ) => Promise<InstallPolicyWarningAcknowledgementResult>;
  trustedSourceLinkedOfficialInstall?: boolean;
};
