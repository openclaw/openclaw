/** Correlate telegram outbound deliveries with the active inbound turn (#78685). */

export type TelegramInboundTurnDeliveryEnd = () => void;

type ActiveTurn = {
  outboundTo: string;
  outboundAccountId?: string;
  markInboundTurnDelivered: () => void;
};

const registry = new Map<string, ActiveTurn>();

export function beginTelegramInboundTurnDeliveryCorrelation(
  sessionKey: string | undefined,
  turn: ActiveTurn,
): TelegramInboundTurnDeliveryEnd {
  const key = sessionKey?.trim();
  if (!key) {
    return () => {};
  }
  registry.set(key, turn);
  return () => {
    registry.delete(key);
  };
}

export function notifyTelegramInboundTurnOutboundSuccess(params: {
  sessionKey: string | undefined;
  channelId: string;
  to: string;
  accountId?: string | null;
  success: boolean;
}): void {
  if (!params.success || params.channelId !== "telegram" || !params.sessionKey?.trim()) {
    return;
  }
  const turn = registry.get(params.sessionKey);
  if (!turn || turn.outboundTo !== params.to) {
    return;
  }
  if (turn.outboundAccountId && params.accountId && params.accountId !== turn.outboundAccountId) {
    return;
  }
  turn.markInboundTurnDelivered();
}
