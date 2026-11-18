import { operatorReadShareKey } from "./read-share-keys.js";

export const CONTROL_PLANE_WRITE = { controlPlaneWrite: true } as const;
export const SIDECAR_CONTROL_PLANE_WRITE = { startup: true, controlPlaneWrite: true } as const;
export const UNADVERTISED = { advertise: false } as const;
export const PROFILE_DEPENDENT = { profileAccess: "required" } as const;
export const PROFILE_STARTUP = { startup: true, ...PROFILE_DEPENDENT } as const;
export const SESSION_METADATA_READ = {
  shareKey: operatorReadShareKey,
  shareMaxAgeMs: 1_000,
  shareInvalidationEvents: ["sessions.changed", "chat.metadata.changed"],
} as const;
export const OBSERVATION = { lifetime: "observation" } as const;
export const UNADVERTISED_OBSERVATION = { ...UNADVERTISED, ...OBSERVATION } as const;
export const SESSION_WRITE = { sessionAccess: { mode: "write" } } as const;
export const OWN_SESSION_WRITE = {
  sessionAccess: { mode: "write", allowOwnSessionScope: true },
} as const;
export const PORTAL_SESSION_WRITE = {
  sessionAccess: { mode: "write", allowOwnSessionScope: true, requiredTool: "portal" },
} as const;
