import "./fs-safe-defaults.js";
import {
  summarizeWindowsAcl as summarizeWindowsAclImpl,
  type WindowsAclEntry,
  type WindowsAclSummary,
} from "@openclaw/fs-safe/advanced";

export type { WindowsAclEntry, WindowsAclSummary };

export {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  safeStat,
  type PermissionCheck,
  type PermissionCheckOptions,
} from "@openclaw/fs-safe/permissions";
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  formatWindowsAclSummary,
  inspectWindowsAcl,
  parseIcaclsOutput,
  resolveWindowsUserPrincipal,
  type PermissionExec as ExecFn,
} from "@openclaw/fs-safe/advanced";

function normalizeWindowsPrincipal(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isLocalizedNtAuthoritySystem(principal: string): boolean {
  return normalizeWindowsPrincipal(principal) === "nt authority\\systeme";
}

export function summarizeWindowsAcl(
  entries: WindowsAclEntry[],
  env?: NodeJS.ProcessEnv,
): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup"> {
  const summary = summarizeWindowsAclImpl(entries, env);
  const trusted = [...summary.trusted];
  const untrustedGroup = [];

  for (const entry of summary.untrustedGroup) {
    if (isLocalizedNtAuthoritySystem(entry.principal)) {
      trusted.push(entry);
    } else {
      untrustedGroup.push(entry);
    }
  }

  return {
    trusted,
    untrustedWorld: summary.untrustedWorld,
    untrustedGroup,
  };
}
