import type { CronStreamSandboxTarget } from "./stream-sandbox-target.js";

export function makeCronStreamSandboxTarget(
  overrides: Partial<CronStreamSandboxTarget> = {},
): CronStreamSandboxTarget {
  return {
    version: 1,
    backendId: "docker",
    agentId: "main",
    sessionKey: "agent:main:watcher",
    sessionId: "creator-session",
    lifecycleRevision: "creator-generation",
    scopeKey: "agent:main:watcher",
    workspaceDir: "/sandbox/workspace",
    agentWorkspaceDir: "/agent/workspace",
    workspaceAccess: "rw",
    containerWorkdir: "/workspace",
    configLabel: "sandbox-config-v1",
    operator: {
      profileId: "profile-ada",
      scopes: ["operator.write"],
      assignedRole: null,
      githubLogin: null,
      gatewayAccessGrant: null,
    },
    ...overrides,
  };
}
