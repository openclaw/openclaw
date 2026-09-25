import { defineLegacyConfigMigration, getRecord } from "../../../config/legacy.shared.js";

function legacyDeviceInferenceProfiles(value: unknown) {
  return Object.entries(getRecord(value) ?? {}).flatMap(([id, profileValue]) => {
    const profile = getRecord(profileValue);
    const settings = getRecord(profile?.settings);
    return typeof profile?.provider === "string" &&
      profile.provider.trim() === "device" &&
      settings?.inference === "runtime-local"
      ? [{ id, settings }]
      : [];
  });
}

export const LEGACY_CONFIG_MIGRATION_RUNTIME_WORKER_INFERENCE = defineLegacyConfigMigration({
  id: "cloudWorkers.profiles.worker-inference",
  describe: "Rename explicit device worker inference placement",
  legacyRules: [
    {
      path: ["cloudWorkers", "profiles"],
      message:
        'Device profile settings.inference "runtime-local" is now "worker". Run "openclaw doctor --fix".',
      match: (value) => legacyDeviceInferenceProfiles(value).length > 0,
    },
  ],
  apply: (raw, changes) => {
    for (const { id, settings } of legacyDeviceInferenceProfiles(
      getRecord(raw.cloudWorkers)?.profiles,
    )) {
      settings.inference = "worker";
      changes.push(
        "Renamed cloudWorkers.profiles." +
          id +
          '.settings.inference from "runtime-local" to "worker".',
      );
    }
  },
});
