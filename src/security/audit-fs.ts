import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  type PermissionCheck,
  type PermissionCheckOptions,
} from "@openclaw/fs-safe/permissions";
import type { SecurityAuditFinding } from "./audit.types.js";

/** Filesystem permission audit facade backed by fs-safe permission helpers. */
export {
  inspectPathPermissions,
  safeStat,
  type PermissionCheck,
  type PermissionCheckOptions,
} from "@openclaw/fs-safe/permissions";

/** Classifiers keep policy; this owner appends observed permissions and remediation. */
export function createPermissionAuditor(
  findings: SecurityAuditFinding[],
  params: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    execIcacls?: PermissionCheckOptions["exec"];
  },
) {
  return async (
    targetPath: string,
    isDir: boolean,
    classify: (perms: PermissionCheck) => Omit<SecurityAuditFinding, "remediation"> | undefined,
  ): Promise<void> => {
    const perms = await inspectPathPermissions(targetPath, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (!perms.ok) {
      return;
    }
    const finding = classify(perms);
    if (finding) {
      findings.push({
        ...finding,
        detail: `${formatPermissionDetail(targetPath, perms)}; ${finding.detail}`,
        remediation: formatPermissionRemediation({
          targetPath,
          perms,
          isDir,
          posixMode: isDir ? 0o700 : 0o600,
          env: params.env,
        }),
      });
    }
  };
}
