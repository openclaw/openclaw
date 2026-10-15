export const META_FIELD_HELP: Record<string, string> = {
  meta: "Backward-readable compatibility metadata retained so older binaries can refuse unsafe config downgrades.",
  "meta.lastTouchedVersion": "OpenClaw version that most recently wrote this config.",
  "meta.migrations": "Bounded compatibility markers for completed config migrations.",
  "meta.migrations.modelPolicyAllowlist":
    "Records that legacy model-map restrictions were preserved or evaluated.",
  "meta.migrations.utilityModelSeparation":
    "Records that legacy implicit primary models were preserved before separating utility model selection.",
};

export const META_FIELD_LABELS: Record<string, string> = {
  meta: "Compatibility Metadata",
  "meta.lastTouchedVersion": "Config Last Touched Version",
  "meta.migrations": "Config Migration Markers",
  "meta.migrations.modelPolicyAllowlist": "Model Policy Allowlist Migration",
  "meta.migrations.utilityModelSeparation": "Utility Model Separation Migration",
};
