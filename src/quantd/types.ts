export type QuantdEventKind = "heartbeat" | "market_event" | "order_event";

export type QuantdEventInputBase = {
  eventId?: string;
  idempotencyKey?: string;
  source?: string;
  occurredAt?: string;
};

export type QuantdHeartbeatEvent = QuantdEventInputBase & {
  status?: string;
  note?: string;
};

export type QuantdMarketEvent = QuantdEventInputBase & {
  symbol?: string;
  signal?: string;
  price?: number;
};

export type QuantdOrderEvent = QuantdEventInputBase & {
  orderId?: string;
  accountId?: string;
  symbol?: string;
  status?: string;
  side?: string;
  quantity?: number;
};

export type QuantdEventPayload = QuantdHeartbeatEvent | QuantdMarketEvent | QuantdOrderEvent;

export type QuantdWalRecord = {
  sequence: number;
  kind: QuantdEventKind;
  receivedAt: string;
  eventId?: string;
  idempotencyKey?: string;
  source?: string;
  occurredAt?: string;
  payload: Record<string, unknown>;
};

export type QuantdPrepareEventResult =
  | {
      duplicate: true;
      existingSequence: number;
    }
  | {
      duplicate: false;
      record: QuantdWalRecord;
    };

export type QuantdCommitRecordOptions = {
  fromReplay?: boolean;
};

export type QuantdRecentEvent = {
  sequence: number;
  kind: QuantdEventKind;
  receivedAt: string;
  eventId?: string;
  summary: string;
};

export type QuantdSnapshot = {
  health: {
    status: "ok" | "degraded";
    reasons: string[];
    lastHeartbeatAt?: string;
    lastMarketEventAt?: string;
    lastOrderEventAt?: string;
  };
  wal: {
    path: string;
    records: number;
  };
  replay: {
    lastSequence: number;
    replayedRecords: number;
  };
  metrics: {
    heartbeats: number;
    marketEvents: number;
    orderEvents: number;
    duplicateEvents: number;
  };
  recentEvents: QuantdRecentEvent[];
};

export type QuantdIngestResult = {
  ok: true;
  applied: boolean;
  replayed: boolean;
  sequence: number;
  kind: QuantdEventKind;
};
