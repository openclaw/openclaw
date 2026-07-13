/** Windows ACL audit facade backed by shared infra permission helpers. */
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  type ExecFn,
} from "../infra/permissions.js";
