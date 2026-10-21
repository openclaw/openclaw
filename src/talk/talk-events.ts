import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { TalkEvent as ProtocolTalkEvent } from "../../packages/gateway-protocol/src/schema/channels.js";
import {
  TALK_CAPTURE_SCOPED_EVENT_TYPES,
  TALK_EVENT_TYPES,
  TALK_TURN_SCOPED_EVENT_TYPES,
} from "../../packages/gateway-protocol/src/talk-event-vocabulary.js";

export { TALK_EVENT_TYPES };

export type TalkEventType = (typeof TALK_EVENT_TYPES)[number];

export type TalkMode = ProtocolTalkEvent["mode"];

export type TalkTransport = ProtocolTalkEvent["transport"];

export type TalkBrain = ProtocolTalkEvent["brain"];

export type TalkEventContext = SchemaContract<
  Pick<ProtocolTalkEvent, "sessionId" | "mode" | "transport" | "brain" | "provider">
>;

export type TalkEvent<TPayload = unknown> = SchemaContract<Omit<ProtocolTalkEvent, "payload">> & {
  payload: TPayload;
};

/** Session context, id, sequence, and the default timestamp are supplied by the sequencer. */
export type TalkEventInput<TPayload = unknown> = Omit<
  TalkEvent<TPayload>,
  keyof TalkEventContext | "id" | "seq" | "timestamp"
> & {
  timestamp?: string;
};

export type TalkEventSequencer = {
  next<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload>;
};

// Turn-scoped event names must carry turnId so mixed audio/text/tool streams can be
// reconstructed without guessing from sequence order alone.
const TURN_SCOPED_TALK_EVENT_TYPES = new Set<TalkEventType>(TALK_TURN_SCOPED_EVENT_TYPES);

// Capture-scoped events describe microphone capture lifecycle, which can overlap turns.
const CAPTURE_SCOPED_TALK_EVENT_TYPES = new Set<TalkEventType>(TALK_CAPTURE_SCOPED_EVENT_TYPES);

function assertTalkEventCorrelation(input: TalkEventInput): void {
  if (TURN_SCOPED_TALK_EVENT_TYPES.has(input.type) && !input.turnId?.trim()) {
    throw new Error(`Talk event ${input.type} requires turnId`);
  }
  if (CAPTURE_SCOPED_TALK_EVENT_TYPES.has(input.type) && !input.captureId?.trim()) {
    throw new Error(`Talk event ${input.type} requires captureId`);
  }
}

export function createTalkEventSequencer(
  context: TalkEventContext,
  options: { now?: () => Date | string } = {},
): TalkEventSequencer {
  let seq = 0;
  const now = options.now ?? (() => new Date());
  return {
    next<TPayload>(input: TalkEventInput<TPayload>): TalkEvent<TPayload> {
      assertTalkEventCorrelation(input);
      seq += 1;
      const timestamp =
        input.timestamp ??
        (() => {
          const value = now();
          return typeof value === "string" ? value : value.toISOString();
        })();
      return {
        ...context,
        id: `${context.sessionId}:${seq}`,
        type: input.type,
        turnId: input.turnId,
        captureId: input.captureId,
        seq,
        timestamp,
        final: input.final,
        callId: input.callId,
        itemId: input.itemId,
        parentId: input.parentId,
        payload: input.payload,
      };
    },
  };
}
