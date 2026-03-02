type RouteLike = {
  agentId: string;
  sessionKey: string;
};

export function createInboundEnvelopeBuilder<TConfig, TEnvelope>(params: {
  cfg: TConfig;
  route: RouteLike;
  sessionStore?: string;
  resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
  readSessionUpdatedAt: (params: { storePath: string; sessionKey: string }) => number | undefined;
  resolveEnvelopeFormatOptions: (cfg: TConfig) => TEnvelope;
  formatAgentEnvelope: (params: {
    channel: string;
    from: string;
    timestamp?: number;
    previousTimestamp?: number;
    envelope: TEnvelope;
    body: string;
  }) => string;
}) {
  const storePath = params.resolveStorePath(params.sessionStore, {
    agentId: params.route.agentId,
  });
  const envelopeOptions = params.resolveEnvelopeFormatOptions(params.cfg);
  return (input: { channel: string; from: string; body: string; timestamp?: number }) => {
    const previousTimestamp = params.readSessionUpdatedAt({
      storePath,
      sessionKey: params.route.sessionKey,
    });
    const body = params.formatAgentEnvelope({
      channel: input.channel,
      from: input.from,
      timestamp: input.timestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: input.body,
    });
    return { storePath, body };
  };
}
