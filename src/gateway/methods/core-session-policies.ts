export const SESSION_WRITE = { sessionAccess: { mode: "write" } } as const;
export const OWN_SESSION_WRITE = {
  sessionAccess: { mode: "write", allowOwnSessionScope: true },
} as const;
export const PORTAL_SESSION_WRITE = {
  sessionAccess: { mode: "write", allowOwnSessionScope: true, requiredTool: "portal" },
} as const;
