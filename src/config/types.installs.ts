/** Base persisted install record shared by plugin and skill install tracking. */
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
<<<<<<< HEAD
  clawhubTrustDisposition?: "clean" | "review-recommended" | "review-required" | "blocked";
  clawhubTrustScanStatus?: string;
  clawhubTrustModerationState?: string;
  clawhubTrustReasons?: string[];
  clawhubTrustPending?: boolean;
  clawhubTrustStale?: boolean;
  clawhubTrustCheckedAt?: string;
  clawhubTrustAcknowledgedAt?: string;
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  artifactKind?: "legacy-zip" | "npm-pack";
  artifactFormat?: "zip" | "tgz";
  npmIntegrity?: string;
  npmShasum?: string;
  npmTarballName?: string;
  clawpackSha256?: string;
  clawpackSpecVersion?: number;
  clawpackManifestSha256?: string;
  clawpackSize?: number;
  gitUrl?: string;
  gitRef?: string;
  gitCommit?: string;
};
