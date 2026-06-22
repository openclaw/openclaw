/** Base persisted install record shared by plugin and skill install tracking. */
export type InstallIntentProvenance =
  | "explicit_user_pin"
  | "prior_default_intent_system_pin"
  | "unknown";

export type InstallIntentProvenanceMigration = {
  id: "stable-plugin-install-intent-v1";
  source: "doctor:stable-plugin-install-intent";
  migratedAt: string;
  decision: InstallIntentProvenance;
  evidence?: {
    spec?: string;
    resolvedSpec?: string;
    trustedSourceLinkedOfficialInstall?: boolean;
  };
};

export type InstallRecordBase = {
  source: "npm" | "archive" | "path" | "clawhub" | "git";
  spec?: string;
  sourcePath?: string;
  installPath?: string;
  version?: string;
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
  installedAt?: string;
  clawhubUrl?: string;
  clawhubPackage?: string;
  clawhubFamily?: "code-plugin" | "bundle-plugin";
  clawhubChannel?: "official" | "community" | "private";
  artifactKind?: "legacy-zip" | "npm-pack";
  artifactFormat?: "zip" | "tgz";
  npmIntegrity?: string;
  npmShasum?: string;
  npmTarballName?: string;
  installIntentProvenance?: InstallIntentProvenance;
  installIntentProvenanceMigration?: InstallIntentProvenanceMigration;
  clawpackSha256?: string;
  clawpackSpecVersion?: number;
  clawpackManifestSha256?: string;
  clawpackSize?: number;
  gitUrl?: string;
  gitRef?: string;
  gitCommit?: string;
};
