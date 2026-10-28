import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import {
  AUTOMATION_RESULT_MODEL,
  OPENCLAW_DELIVERY_MIRROR_MODEL,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { resolveRecoveryNoticeSettlementError } from "./session-work-start.js";
import {
  sameTranscriptEntryAnchor,
  type TranscriptEntryAnchor,
} from "./transcript-entry-anchor.js";
import type { InternalSessionEntry } from "./types.js";

export type RecoveryNoticeDestination = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number | null;
};

export type RecoveryNoticeMirror = {
  kind: "restart-recovery-notice";
  noticeId: string;
  cycleId: string;
  revision: number;
  noticePart: 0;
  destination?: RecoveryNoticeDestination;
};

/** Physical/session custody travels separately; model provenance contains no store locations. */
export type RecoveryNoticeProvenance = {
  kind: "recovery-notice";
  noticeId: string;
  localNotice?: Pick<
    TranscriptEntryAnchor,
    "generation" | "entryId" | "rawSeq" | "effectiveParentId" | "activeMessagePosition"
  >;
};

export type RecoveryNoticePredicate = {
  kind: "recovery-notice";
  noticeId: string;
  anchor: NonNullable<RecoveryNoticeProvenance["localNotice"]>;
  destination: RecoveryNoticeDestination;
  priorEntryId?: string;
};

/** Both storage owners validate the immutable local row inside their append transaction. */
export function assertAcceptedRecoveryNotice(params: {
  sessionKey: string;
  entry: InternalSessionEntry;
  predicate: RecoveryNoticePredicate;
  anchor: TranscriptEntryAnchor | undefined;
  localMessage: unknown;
  message: unknown;
}): void {
  const { anchor, predicate, message } = params;
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : undefined;
  const accepted = content?.[0];
  const provenance = isRecord(message) ? message.openclawAutomation : undefined;
  if (
    !anchor ||
    !sameTranscriptEntryAnchor({ ...anchor, ...predicate.anchor }, anchor) ||
    anchor.idempotencyKey !== predicate.noticeId ||
    !isRecord(message) ||
    message.role !== "assistant" ||
    message.provider !== OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER ||
    message.model !== AUTOMATION_RESULT_MODEL ||
    !isRecord(provenance) ||
    provenance.kind !== "recovery-notice" ||
    provenance.noticeId !== predicate.noticeId ||
    content?.length !== 1 ||
    !isRecord(accepted) ||
    accepted.type !== "text" ||
    typeof accepted.text !== "string"
  ) {
    throw new Error("accepted recovery notice no longer owns its local transcript anchor");
  }
  const hidden = shouldHideAcceptedRecoveryNotice({
    sessionKey: params.sessionKey,
    entry: params.entry,
    noticeId: predicate.noticeId,
    localMessage: params.localMessage,
    destination: predicate.destination,
    text: accepted.text,
  });
  if ((message.display === false) !== hidden) {
    throw new Error("accepted recovery notice display relation changed before commit");
  }
}

/** Called again inside the commit: a local display row alone never authorizes model history. */
export function shouldHideAcceptedRecoveryNotice(params: {
  sessionKey: string;
  entry: InternalSessionEntry;
  noticeId: string;
  localMessage: unknown;
  destination: RecoveryNoticeDestination;
  text: string;
}): boolean {
  const message = params.localMessage;
  const marker = isRecord(message) ? message.openclawDeliveryMirror : undefined;
  const notice =
    isRecord(message) && Array.isArray(message.content) ? message.content[0] : undefined;
  if (
    !isRecord(message) ||
    message.role !== "assistant" ||
    message.provider !== OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER ||
    message.model !== OPENCLAW_DELIVERY_MIRROR_MODEL ||
    message.idempotencyKey !== params.noticeId ||
    !isRecord(marker) ||
    marker.kind !== "restart-recovery-notice" ||
    marker.noticeId !== params.noticeId ||
    marker.noticePart !== 0 ||
    typeof marker.cycleId !== "string" ||
    typeof marker.revision !== "number" ||
    !isRecord(marker.destination) ||
    !channelRouteTargetsMatchExact({ left: marker.destination, right: params.destination }) ||
    !isRecord(notice) ||
    notice.type !== "text" ||
    typeof notice.text !== "string"
  ) {
    throw new Error("accepted recovery notice does not match its local notice and destination");
  }
  const unavailable = resolveRecoveryNoticeSettlementError(params.sessionKey, params.entry, {
    cycleId: marker.cycleId,
    revision: marker.revision,
  });
  if (unavailable) {
    throw new Error(unavailable);
  }
  // Channel normalization may change the text. Keep the actual accepted text visible in that case.
  return params.text === notice.text;
}
