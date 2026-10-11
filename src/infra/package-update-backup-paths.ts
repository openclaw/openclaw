import { isPackageActivationArtifactName } from "./package-update-activation-paths.js";

export function isLegacyPackageBackupName(name: string): boolean {
  return /^\.openclaw[.-]package-backup-\d+-\d+$/u.test(name);
}

export function isPackageUpdateRecoveryArtifactName(name: string): boolean {
  return /^\.openclaw[.-]package-backup-/u.test(name) || isPackageActivationArtifactName(name);
}
