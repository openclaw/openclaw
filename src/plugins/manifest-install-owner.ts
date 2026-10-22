import { createPluginInstallOwnerMetadata } from "./candidate-install-owner.js";

export const {
  record: recordPluginManifestInstallOwner,
  resolve: resolvePluginManifestInstallOwner,
  isAmbiguous: isPluginManifestInstallOwnerAmbiguous,
} = createPluginInstallOwnerMetadata("openclaw.pluginManifestInstallOwner", false);
