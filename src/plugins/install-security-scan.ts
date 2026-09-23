// Runs security checks over plugin install candidates before activation.
import { createLazyRuntimeMethodBinder } from "../shared/lazy-runtime.js";
import type { InstallPolicyWarningDetails } from "./install-security-scan.types.js";
export type {
  InstallSafetyOverrides,
  SkillInstallSpecMetadata,
} from "./install-security-scan.types.js";

/** Result returned by plugin/skill install security policy checks. */
export type InstallSecurityScanResult = {
  blocked?: {
    code?: "security_scan_blocked" | "security_scan_failed";
    reason: string;
    installPolicyWarning?: InstallPolicyWarningDetails;
  };
};

/** Lazily loads install scanning so normal plugin startup avoids policy/runtime imports. */
async function loadInstallSecurityScanRuntime() {
  return await import("./install-security-scan.runtime.js");
}

const bindInstallSecurityScanRuntime = createLazyRuntimeMethodBinder(
  loadInstallSecurityScanRuntime,
);

/** Scans an unpacked bundle source before plugin install/update. */
export const scanBundleInstallSource = bindInstallSecurityScanRuntime(
  (runtime) => runtime.scanBundleInstallSourceRuntime,
);

/** Scans a package source directory and executable metadata before install/update. */
export const scanPackageInstallSource = bindInstallSecurityScanRuntime(
  (runtime) => runtime.scanPackageInstallSourceRuntime,
);

/** Scans the installed package dependency tree after npm resolution. */
export const scanInstalledPackageDependencyTree = bindInstallSecurityScanRuntime(
  (runtime) => runtime.scanInstalledPackageDependencyTreeRuntime,
);

/**
 * Retained for install.runtime compatibility with pre-v2026.6.5 lazy install chunks.
 * Remove only with the matching runtime-postbuild legacy alias cleanup.
 */
export const scanFileInstallSource = bindInstallSecurityScanRuntime(
  (runtime) => runtime.scanFileInstallSourceRuntime,
);

/** Runs npm install policy checks before package install side effects. */
export const preflightPluginNpmInstallPolicy = bindInstallSecurityScanRuntime(
  (runtime) => runtime.preflightPluginNpmInstallPolicyRuntime,
);

/** Runs git install policy checks before plugin install side effects. */
export const preflightPluginGitInstallPolicy = bindInstallSecurityScanRuntime(
  (runtime) => runtime.preflightPluginGitInstallPolicyRuntime,
);

/** Evaluates shared install policy for skill-managed dependency installs. */
export const evaluateSkillInstallPolicy = bindInstallSecurityScanRuntime(
  (runtime) => runtime.evaluateSkillInstallPolicyRuntime,
);
