import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import type { AutoSteerReceipt } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { persistedSteerTargetRunId } from "../stream-causal-boundary.ts";

registerChatMessageMetadataEnglish();
const reasons = {
  decision: "chat.autoSteer.decision",
  abstained: "chat.autoSteer.abstained",
  unavailable: "chat.autoSteer.unavailable",
  deadline: "chat.autoSteer.deadline",
  ineligible: "chat.autoSteer.ineligible",
  "stale-turn": "chat.autoSteer.staleTurn",
} as const satisfies Record<AutoSteerReceipt["reason"], string>;

function isReason(value: unknown): value is AutoSteerReceipt["reason"] {
  return typeof value === "string" && Object.hasOwn(reasons, value);
}

export function renderAutoSteerReceipt(message: unknown) {
  const row = asOptionalRecord(message);
  const receipt = asOptionalRecord(asOptionalRecord(row?.["__openclaw"])?.autoSteer);
  if (
    row?.role !== "user" ||
    !receipt ||
    !isReason(receipt.reason) ||
    (receipt.choice !== undefined && receipt.choice !== "steer" && receipt.choice !== "followup") ||
    (receipt.reason === "decision" && receipt.choice === undefined)
  ) {
    return nothing;
  }
  const label =
    receipt.reason !== "decision"
      ? "chat.autoSteer.fallback"
      : receipt.choice === "steer"
        ? "chat.autoSteer.selectedSteer"
        : "chat.autoSteer.selectedFollowup";
  // Advice is not consumption. Only the transcript owner's canonical receipt proves steering.
  return html`<span class="chat-auto-steer-receipt" title=${t(reasons[receipt.reason])}>
    ${t(label)}${persistedSteerTargetRunId(message) ? html` · ${t("chat.autoSteer.steered")}` : nothing}
  </span>`;
}
