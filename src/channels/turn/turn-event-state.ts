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
  status?: TurnEventStatus | string;
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

function createTurnEventId(): string {
  inMemoryTurnEventSequence += 1;
  return `turn-event-${inMemoryTurnEventSequence}`;
}

/** Spike store for modelling turn event timelines without adding persistence yet. */
export class InMemoryTurnEventStore implements TurnEventRecorder {
  private readonly events: TurnEvent[] = [];
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: { now?: () => number; createId?: () => string } = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? createTurnEventId;
  }

  append(event: AppendTurnEventInput): TurnEvent {
    const recorded: TurnEvent = {
      id: event.id ?? this.createId(),
      timestamp: event.timestamp ?? this.now(),
      ...event,
    };
    this.events.push(recorded);
    return recorded;
  }

  list(turnId: string): readonly TurnEvent[] {
    return this.events.filter((event) => event.turnId === turnId);
  }

  all(): readonly TurnEvent[] {
    return [...this.events];
  }
}

export function materializeTurnState(events: readonly TurnEvent[]): TurnState {
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
        state.errors.push(String(event.metadata?.reason ?? "delivery_failed"));
        break;
      case "turn.failed":
        state.currentState = "failed";
        state.errors.push(String(event.metadata?.reason ?? "turn_failed"));
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
  state.errors = [...state.errors, ...completionErrors];
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
