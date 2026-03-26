export const INSTALL_CODE_SAFETY_MODE_VALUES = ["warn", "block-critical"] as const;

export type InstallCodeSafetyMode = (typeof INSTALL_CODE_SAFETY_MODE_VALUES)[number];

export function resolveInstallCodeSafetyMode(mode?: InstallCodeSafetyMode): InstallCodeSafetyMode {
  return mode ?? "warn";
}
