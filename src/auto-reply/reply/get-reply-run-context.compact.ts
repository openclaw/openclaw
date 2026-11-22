import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { TemplateContext } from "../templating.js";
import { projectTelegramCurrentMessageCarrier } from "./inbound-meta.current-message.js";
import {
  buildCompactInboundUserContextPrefix,
  type CompactInboundContextProjection,
} from "./inbound-meta.js";

const RESUMABLE_ROOM_CONTEXT_OMITTED_PREFIXES = [
  "Conversation context (chronological, selected for current message):",
  "Chat history since last reply:",
  "Recent chat history:",
];

/** Drops the history blocks a resumed room-event turn already holds in its transcript. */
export function buildResumableRoomContext(roomContext: string): string {
  return roomContext
    .split(/\n{2,}/u)
    .filter(
      (block) =>
        !RESUMABLE_ROOM_CONTEXT_OMITTED_PREFIXES.some((prefix) => block.startsWith(prefix)),
    )
    .join("\n\n");
}

/** Compact inbound projection for one turn, with the PR attribution prompt prepended. */
export function buildCompactInboundContext(params: {
  isInternalEvent: boolean;
  sessionCtx: TemplateContext;
  sessionEntry: SessionEntry | undefined;
  attributionPrompt: () => string;
}): CompactInboundContextProjection {
  if (params.isInternalEvent) {
    return { text: "", removedSessionMessages: 0, deduplicatedMessages: 0 };
  }
  const compact = buildCompactInboundUserContextPrefix(params.sessionCtx, params.sessionEntry);
  const withAttribution = (text: string | undefined) =>
    [params.attributionPrompt(), text].filter(Boolean).join("\n\n");
  return {
    ...compact,
    text: withAttribution(compact.text),
    resumableText: withAttribution(compact.resumableText ?? compact.text),
  };
}

/** Compact fields of the current inbound prompt context, spread next to the default text. */
export function buildCompactCurrentInboundFields(params: {
  compactInboundContext: CompactInboundContextProjection;
  sessionCtx: TemplateContext;
  isRoomEvent: boolean;
  deliveryDirective: string | undefined;
  roomEventPrompt: string;
  promptJoiner: " " | undefined;
  buildRoomEventContext: (roomContext: string) => string;
}) {
  const { compactInboundContext, deliveryDirective } = params;
  const normalized = compactInboundContext.text.trim();
  const compactText = params.isRoomEvent
    ? params.buildRoomEventContext(normalized)
    : (params.promptJoiner === " "
        ? [deliveryDirective, normalized]
        : [normalized, deliveryDirective]
      )
        .filter(Boolean)
        .join("\n\n");
  // Instructions stay instructions; only the compact facts and history are quoted data.
  const compactFragments: RuntimeContextFragment[] = [
    ...(params.isRoomEvent
      ? [{ kind: "runtime-instruction" as const, text: params.roomEventPrompt }]
      : []),
    // The standalone carrier needs the current body; compactText keeps the bare inline header.
    ...(normalized
      ? [
          {
            kind: "conversation-data" as const,
            text: projectTelegramCurrentMessageCarrier(normalized, params.sessionCtx),
          },
        ]
      : []),
    ...(deliveryDirective
      ? [{ kind: "runtime-instruction" as const, text: deliveryDirective }]
      : []),
  ];
  return {
    compactText,
    compactFragments,
    ...(params.isRoomEvent
      ? {
          compactResumableText: params.buildRoomEventContext(
            (compactInboundContext.resumableText ?? compactInboundContext.text).trim(),
          ),
        }
      : {}),
    serializationStats: {
      removedSessionMessages: compactInboundContext.removedSessionMessages,
      deduplicatedMessages: compactInboundContext.deduplicatedMessages,
    },
  };
}
