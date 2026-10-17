/** Bundled Discord and default Slack slash-command dispatch sessions, not conversation targets. */
export function isNativeCommandSourceSessionKey(sessionKey: string): boolean {
  return (
    /^agent:[^:]+:discord:slash:[^:]+$/.test(sessionKey) ||
    /^agent:[^:]+:slack:slash:(?:[^:]+|team:[^:]+:user:[^:]+)$/.test(sessionKey)
  );
}
