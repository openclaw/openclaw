/** Filesystem permission audit facade backed by fs-safe permission helpers. */
export {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  safeStat,
  type PermissionCheck,
  type PermissionCheckOptions,
} from "@openclaw/fs-safe/permissions";
