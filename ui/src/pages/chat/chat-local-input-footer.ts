// Leaf contract for live local session receipt footers. Import-free of chat
// page modules so transcript renderers can read bubble metadata without cycles.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { SessionLocalInputState } from "../../lib/sessions/local-source.ts";

/** Footer facts carried on the projected bubble so the renderer stays pure. */
export type LocalInputFooter = {
  inputId: string;
  sourceLabel: string;
  /** Sources without steering read new input at their next turn boundary. */
  nextTurnDelivery: boolean;
  state: SessionLocalInputState;
  reason?: string;
};

export const LOCAL_INPUT_STATES: ReadonlySet<string> = new Set([
  "accepted",
  "submitted",
  "committed",
  "rejected",
]);

export function readLocalInputFooter(message: unknown): LocalInputFooter | null {
  const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
  const footer = asNullableRecord(metadata?.localInput);
  const inputId = footer?.inputId;
  const state = footer?.state;
  if (typeof inputId !== "string" || typeof state !== "string" || !LOCAL_INPUT_STATES.has(state)) {
    return null;
  }
  return {
    inputId,
    sourceLabel: typeof footer?.sourceLabel === "string" ? footer.sourceLabel : "",
    nextTurnDelivery: footer?.nextTurnDelivery === true,
    // SAFETY: state was checked against the closed input-state list above.
    state: state as SessionLocalInputState,
    ...(typeof footer?.reason === "string" ? { reason: footer.reason } : {}),
  };
}

export function localInputFooterLabel(footer: LocalInputFooter): string {
  const source = footer.sourceLabel || t("chat.localSession.device");
  switch (footer.state) {
    case "accepted":
      return t("chat.localSession.receipt.sending");
    case "submitted":
      return footer.nextTurnDelivery
        ? t("chat.localSession.receipt.deliveredNextTurn", { source })
        : t("chat.localSession.receipt.delivered", { source });
    case "committed":
      return t("chat.localSession.receipt.received", { source });
    case "rejected":
      return footer.reason
        ? t("chat.localSession.receipt.rejectedReason", { source, reason: footer.reason })
        : t("chat.localSession.receipt.rejected", { source });
    default:
      return footer.state satisfies never;
  }
}
