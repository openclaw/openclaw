type MaybePromise<T> = T | Promise<T>;

export type TurnEventType =
  | "message.received"
  | "turn.started"
  | "delivery.required"
  | "tool.called"
  | "tool.result"
  | "delivery.sent"
  | "delivery.failed"
  | "turn.completed"
  | "turn.failed";

export type TurnEventStatus =
  | "received"
  | "started"
  | "required"
  | "sent"
  | "failed"
  | "completed"
  | "valid"
  | "invalid";

export type TurnEventMetadataValue = string | number | boolean | null | undefined;

export type TurnEventMetadata = Record<string, TurnEventMetadataValue>;

export type TurnEvent = {
  id: string;
  type: TurnEventType;
  timestamp: number;
  turnId: string;
  runId?: string;
  parentId?: string;
  actor: string;
  channel: string;
  target?: string;
  status?: TurnEventStatus;
  metadata?: TurnEventMetadata;
};

export type AppendTurnEventInput = Omit<TurnEvent, "id" | "timestamp"> &
  Partial<Pick<TurnEvent, "id" | "timestamp">>;

export type TurnEventRecorder = {
  append: (event: AppendTurnEventInput) => MaybePromise<TurnEvent>;
  list?: (turnId: string) => MaybePromise<readonly TurnEvent[]>;
};

export type TurnStateStatus = "idle" | "received" | "started" | "completed" | "failed";

export type TurnState = {
  turnId?: string;
  currentState: TurnStateStatus;
  visibleDeliveryRequired: boolean;
  visibleDeliverySent: boolean;
  completionAllowed: boolean;
  errors: string[];
};

let inMemoryTurnEventSequence = 0;
const DEFAULT_IN_MEMORY_TURN_EVENT_CAPACITY = 1_000;
const MAX_TURN_EVENT_METADATA_STRING_LENGTH = 256;
const SENSITIVE_TURN_EVENT_METADATA_KEY =
  /(?:authorization|body|content|cookie|credential|password|payload|raw|secret|text|token)/i;

function createTurnEventId(): string {
  inMemoryTurnEventSequence += 1;
  return `turn-event-${inMemoryTurnEventSequence}`;
}

function sanitizeTurnEventMetadataValue(value: TurnEventMetadataValue): TurnEventMetadataValue {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= MAX_TURN_EVENT_METADATA_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_TURN_EVENT_METADATA_STRING_LENGTH)}...`;
}

export function sanitizeTurnEventMetadata(
  metadata: TurnEventMetadata | undefined,
): TurnEventMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const sanitized: TurnEventMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      continue;
    }
    sanitized[key] = SENSITIVE_TURN_EVENT_METADATA_KEY.test(key)
      ? "<redacted>"
      : sanitizeTurnEventMetadataValue(value);
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeTurnEvent(event: TurnEvent): TurnEvent {
  const metadata = sanitizeTurnEventMetadata(event.metadata);
  return {
    ...event,
    ...(metadata ? { metadata } : { metadata: undefined }),
  };
}

/** Spike store for modelling turn event timelines without adding persistence yet. */
export class InMemoryTurnEventStore implements TurnEventRecorder {
  private readonly events: TurnEvent[] = [];
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly capacity: number;
  private dropped = 0;

  constructor(options: { now?: () => number; createId?: () => string; capacity?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? createTurnEventId;
    this.capacity =
      typeof options.capacity === "number" && Number.isFinite(options.capacity)
        ? Math.max(0, Math.floor(options.capacity))
        : DEFAULT_IN_MEMORY_TURN_EVENT_CAPACITY;
  }

  append(event: AppendTurnEventInput): TurnEvent {
    const recorded = sanitizeTurnEvent({
      id: event.id ?? this.createId(),
      timestamp: event.timestamp ?? this.now(),
      ...event,
    });
    if (this.capacity <= 0) {
      this.dropped += 1;
      return recorded;
    }
    if (this.events.length >= this.capacity) {
      this.events.shift();
      this.dropped += 1;
    }
    this.events.push(recorded);
    return recorded;
  }

  list(turnId: string): readonly TurnEvent[] {
    return this.events.filter((event) => event.turnId === turnId);
  }

  all(): readonly TurnEvent[] {
    return [...this.events];
  }

  stats(): { capacity: number; count: number; dropped: number } {
    return {
      capacity: this.capacity,
      count: this.events.length,
      dropped: this.dropped,
    };
  }
}

export function materializeTurnState(events: readonly TurnEvent[]): TurnState {
  const errors = new Set<string>();
  const state: TurnState = {
    turnId: events[0]?.turnId,
    currentState: "idle",
    visibleDeliveryRequired: false,
    visibleDeliverySent: false,
    completionAllowed: true,
    errors: [],
  };

  for (const event of events) {
    state.turnId ??= event.turnId;
    switch (event.type) {
      case "message.received":
        if (state.currentState === "idle") {
          state.currentState = "received";
        }
        break;
      case "turn.started":
        if (state.currentState !== "failed" && state.currentState !== "completed") {
          state.currentState = "started";
        }
        break;
      case "delivery.required":
        state.visibleDeliveryRequired = true;
        break;
      case "delivery.sent":
        state.visibleDeliverySent = true;
        break;
      case "delivery.failed":
        state.currentState = "failed";
        errors.add(String(event.metadata?.reason ?? "delivery_failed"));
        break;
      case "turn.failed":
        state.currentState = "failed";
        errors.add(String(event.metadata?.reason ?? "turn_failed"));
        break;
      case "turn.completed":
        if (state.currentState !== "failed") {
          state.currentState = "completed";
        }
        break;
      case "tool.called":
      case "tool.result":
        break;
    }
  }

  const completionErrors = validateTurnCompletion({
    ...state,
    completionAllowed: true,
    errors: [],
  });
  for (const error of completionErrors) {
    errors.add(error);
  }
  state.errors = [...errors];
  state.completionAllowed = state.currentState !== "failed" && completionErrors.length === 0;
  return state;
}

export function validateTurnCompletion(state: TurnState): string[] {
  const errors: string[] = [];
  if (state.visibleDeliveryRequired && !state.visibleDeliverySent) {
    errors.push("missing_visible_delivery");
  }
  return errors;
}
