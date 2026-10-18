/** Windows ACL remediation facade backed by fs-safe permission helpers. */
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  type PermissionExec as ExecFn,
} from "@openclaw/fs-safe/advanced";
