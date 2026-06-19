import type { FsRoot } from "../config/types.tools.js";

/** Filesystem policy for agent tools that can touch local paths. */
export type ToolFsPolicy = {
  workspaceOnly: boolean;
  /** Explicit per-agent filesystem root allowlist (host-mode only). */
  roots?: FsRoot[];
};
