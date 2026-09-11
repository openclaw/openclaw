export const PACKAGE_ACTIVATION_HELPER = "recovery.mjs";
export const packageActivationRuntimeEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "package-update-activation-sealed",
  distWorkerPath: "package-update-activation-recovery.mjs",
};
