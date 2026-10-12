import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { FallbackStatus } from "../tool-stream-contract.ts";

const FALLBACK_TOAST_DURATION_MS = 8000;

export function renderFallbackIndicatorSolid(status: FallbackStatus | null | undefined) {
  if (!status) {
    return null;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return null;
  }
  const details = [
    t("chat.composer.fallbackSelected", { model: status.selected }),
    t("chat.composer.fallbackCurrent", {
      model: phase === "cleared" ? status.selected : status.active,
    }),
    phase === "cleared" && status.previous
      ? t("chat.composer.fallbackPrevious", { model: status.previous })
      : null,
    status.reason ? t("chat.composer.fallbackReason", { reason: status.reason }) : null,
    status.attempts.length > 0
      ? t("chat.composer.fallbackAttempts", {
          attempts: status.attempts.slice(0, 3).join(" | "),
        })
      : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? t("chat.composer.fallbackCleared", { model: status.selected })
      : t("chat.composer.fallbackActive", { model: status.active });
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? <Icon name="check" /> : <Icon name="brain" />;
  return (
    <openclaw-tooltip prop:content={details}>
      <div class={className} role="status" aria-live="polite" aria-label={details}>
        {icon} {message}
      </div>
    </openclaw-tooltip>
  );
}
