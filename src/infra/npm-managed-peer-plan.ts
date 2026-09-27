import { createSafeNpmInstallArgs } from "./safe-package-install.js";

export function createManagedNpmPeerPlanArgs(params?: {
  force?: boolean;
  legacyPeerDeps?: boolean;
}): string[] {
  return [
    "npm",
    "install",
    "--package-lock-only",
    ...(params?.force ? ["--force"] : []),
    ...createSafeNpmInstallArgs({
      omitDev: true,
      omitPeer: true,
      legacyPeerDeps: params?.legacyPeerDeps,
      loglevel: "error",
      ignoreWorkspaces: true,
      noAudit: true,
      noFund: true,
    }).slice(1),
  ];
}
