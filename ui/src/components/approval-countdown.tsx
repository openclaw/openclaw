import { createSignal, onSettled } from "solid-js";
import { registerApprovalsEnglish } from "../i18n/locales/en-approvals.ts";
import { formatCountdown } from "../lib/format.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import type { JSX as SolidJSX } from "../types/solid-elements.d.ts";

registerEnglishCatalog(registerApprovalsEnglish);

export function approvalRemainingLabel(expiresAtMs: number, nowMs: number): string {
  return expiresAtMs > nowMs
    ? t("execApproval.expiresIn", { time: formatCountdown(expiresAtMs, nowMs, true) })
    : t("execApproval.expired");
}

export function useApprovalClock(onTick?: (nowMs: number) => void) {
  const [now, setNow] = createSignal(Date.now());
  onSettled(() => {
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      onTick?.(time);
    }, 1_000);
    return () => clearInterval(timer);
  });
  return now;
}

export function ApprovalCountdown(
  props: Pick<
    SolidJSX.HTMLAttributes<HTMLElement>,
    "class" | "role" | "aria-label" | "aria-hidden" | "title"
  > & { expiresAtMs: number; compact?: boolean },
) {
  let host: HTMLElement | undefined;
  const now = useApprovalClock((time) => {
    if (!props.compact) {
      host
        ?.closest("openclaw-modal-dialog")
        ?.setAttribute("description", approvalRemainingLabel(props.expiresAtMs, time));
    }
  });
  return (
    <openclaw-approval-countdown
      ref={(element) => {
        host = element;
      }}
      style={{ display: "contents" }}
      class={props.class}
      role={props.role}
      aria-label={props["aria-label"]}
      aria-hidden={props["aria-hidden"]}
      title={props.title}
    >
      {props.compact
        ? formatCountdown(props.expiresAtMs, now(), true)
        : approvalRemainingLabel(props.expiresAtMs, now())}
    </openclaw-approval-countdown>
  );
}
