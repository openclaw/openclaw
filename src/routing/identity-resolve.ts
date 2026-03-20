type IdentityResolveHookRunner = {
  hasHooks(hookName: "before_identity_resolve"): boolean;
  runBeforeIdentityResolve(
    event: { peerId: string; channel: string; accountId: string },
    ctx: Record<string, unknown>,
  ): Promise<{ canonicalPeerId?: string } | undefined>;
};

/**
 * Resolve canonical peer identity via plugin hook.
 * Call before resolveAgentRoute for direct-message peers.
 * Returns null if no hook registered, hook returns undefined, or hook fails.
 *
 * Wraps the hook call in try/catch to guarantee fail-open regardless of
 * the hook runner's catchErrors mode.
 */
export async function resolveInboundPeerIdentity(params: {
  peerId: string;
  channel: string;
  accountId: string;
  hookRunner?: IdentityResolveHookRunner;
}): Promise<string | null> {
  if (!params.hookRunner?.hasHooks("before_identity_resolve")) {
    return null;
  }
  try {
    const result = await params.hookRunner.runBeforeIdentityResolve(
      {
        peerId: params.peerId,
        channel: params.channel,
        accountId: params.accountId,
      },
      {},
    );
    return result?.canonicalPeerId?.trim() || null;
  } catch {
    return null;
  }
}
