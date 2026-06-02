import type { OpenClawConfig } from "../../config/types.js";

/** Shared params passed to channel directory listers. */
export type DirectoryConfigParams = {
  /** Current OpenClaw config snapshot. */
  cfg: OpenClawConfig;
  /** Optional configured account to list directory entries for. */
  accountId?: string | null;
  /** Optional case-insensitive filter text. */
  query?: string | null;
  /** Optional positive maximum number of entries to return. */
  limit?: number | null;
};
