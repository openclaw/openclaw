// Defines plugin install security scan result types.
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type InstallPolicyWarningAcknowledgementRequest = {
  targetName: string;
  targetType: "skill" | "plugin";
  requestMode: "install" | "update";
};

/** Overrides that intentionally loosen install safety policy for trusted/operator paths. */
export type InstallSafetyOverrides = {
  config?: OpenClawConfig;
  dangerouslyForceUnsafeInstall?: boolean;
  onInstallPolicyWarning?: (
    request: InstallPolicyWarningAcknowledgementRequest,
  ) => Promise<boolean>;
  trustedSourceLinkedOfficialInstall?: boolean;
};
