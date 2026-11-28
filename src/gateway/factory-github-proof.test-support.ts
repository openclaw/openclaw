/** Fresh session item-read claims for Factory GitHub admission tests. */
export function createFactoryGitHubReadClaim(requestDigest: string) {
  return {
    purpose: "session-item-read" as const,
    binding: {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:room",
      sessionId: "session-1",
      lifecycleRevision: "revision-1",
      requestDigest,
    },
  };
}
