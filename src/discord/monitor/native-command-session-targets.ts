export type ResolveDiscordNativeCommandSessionTargetsParams = {
  boundSessionKey?: string;
  effectiveRoute: {
    agentId: string;
    sessionKey: string;
  };
  sessionPrefix: string;
  userId: string;
};

export function resolveDiscordNativeCommandSessionTargets(
  params: ResolveDiscordNativeCommandSessionTargetsParams,
) {
  const sessionKey =
    params.boundSessionKey ??
    `agent:${params.effectiveRoute.agentId}:${params.sessionPrefix}:${params.userId}`;
  const commandTargetSessionKey = params.boundSessionKey ?? params.effectiveRoute.sessionKey;
  return {
    sessionKey,
    commandTargetSessionKey,
  };
}
