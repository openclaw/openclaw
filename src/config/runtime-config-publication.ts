import type { OpenClawConfig } from "./types.openclaw.js";

/** The runtime config owner publishes identity facts before notifying consumers. */
export const runtimeConfigPublication: {
  current?: { config: OpenClawConfig; revision: object };
} = {};
