import type { PluginInstallRecord } from "../config/types.plugins.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { validatePackagePluginInstallSource } from "./install-installed-package.js";
import { loadPluginInstallRuntime } from "./install-shared.js";
import type {
  InstallPluginResult,
  PackageInstallCommonParams,
  PluginInstallPolicyRequest,
} from "./install-types.js";
import { auditDeclaredOpenClawHostDependency } from "./plugin-peer-link.js";

/** Keep retained installs behind the same source policy and installed-package validation. */
export async function prepareClawHubInstalledRetention(params: {
  install: Pick<
    PackageInstallCommonParams,
    "mode" | "dryRun" | "expectedPluginId" | "onInstallPolicyWarning" | "config" | "logger"
  > & {
    spec: string;
    retainInstalled?: { record: PluginInstallRecord; installPath: string };
  };
  officialClawHubPackage: boolean;
  clawhubAuthority: "openclaw" | "third-party";
  canonicalPackageName: string;
  version: string;
  artifactKind: "npm-pack" | "legacy-zip";
  hasAttestedDigest: boolean;
  integrity: string;
}) {
  const installPolicyRequest: PluginInstallPolicyRequest = {
    kind: "plugin-archive",
    requestedSpecifier: params.install.spec,
    source: {
      kind: "clawhub",
      authority: params.officialClawHubPackage ? "official" : params.clawhubAuthority,
      mutable: false,
      network: true,
    },
  };
  let retainedResult: Extract<InstallPluginResult, { ok: true }> | undefined;
  const retained = params.install.retainInstalled;
  // File-list-only releases still require extraction and verification; a saved
  // observed digest alone is not an attested artifact identity.
  if (
    params.install.mode === "update" &&
    !params.install.dryRun &&
    retained &&
    params.hasAttestedDigest &&
    retained.record.source === "clawhub" &&
    retained.record.clawhubPackage === params.canonicalPackageName &&
    retained.record.version === params.version &&
    retained.record.artifactKind === params.artifactKind &&
    normalizeClawHubSha256Integrity(retained.record.integrity ?? "") === params.integrity &&
    !(await auditDeclaredOpenClawHostDependency({
      packageDir: retained.installPath,
      packageName: params.canonicalPackageName,
    }))
  ) {
    const validated = await validatePackagePluginInstallSource({
      runtime: await loadPluginInstallRuntime(),
      packageDir: retained.installPath,
      expectedPluginId: params.install.expectedPluginId,
      requirePluginManifest: true,
      onInstallPolicyWarning: params.install.onInstallPolicyWarning,
      trustedSourceLinkedOfficialInstall: params.officialClawHubPackage,
      config: params.install.config,
      installPolicyRequest,
      logger: params.install.logger ?? {},
      mode: "update",
    });
    if (validated.ok && validated.plugin.version === params.version) {
      retainedResult = { ok: true, ...validated.plugin, targetDir: retained.installPath };
    }
  }
  return { retainedResult, installPolicyRequest };
}
