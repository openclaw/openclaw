import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { ExecPolicyCeiling } from "../infra/exec-policy.js";

export type PreparedSessionPermissionPolicy = Readonly<{
  root: string;
  mode: SessionPermissionMode;
  /** Stored session mode before participant clamping; undefined retains configured defaults. */
  sourceMode?: SessionPermissionMode;
  /** Retain exact participant defaults when the permission label is lossy (for example allowlist). */
  execPolicy?: ExecPolicyCeiling;
}>;

export type ToolFsPolicy = {
  workspaceOnly: boolean;
  root?: string;
  /** Host-owned roots that read-only tools may consume outside the workspace. */
  readOnlyRoots?: string[];
};
