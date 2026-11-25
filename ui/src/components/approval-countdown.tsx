import { createMemo } from "solid-js";
import { registerApprovalsEnglish } from "../i18n/locales/en-approvals.ts";
import { formatCountdown } from "../lib/format.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { readVisibleTime } from "../lib/reactive/visible-clock.ts";
import type { JSX as SolidJSX } from "../types/solid-elements.d.ts";

registerEnglishCatalog(registerApprovalsEnglish);

export function approvalRemainingLabel(expiresAtMs: number, nowMs: number): string {
  return expiresAtMs > nowMs
    ? t("execApproval.expiresIn", { time: formatCountdown(expiresAtMs, nowMs) })
    : t("execApproval.expired");
}

export function readApprovalTime(expiresAtMs: number): number {
  const now = Date.now();
  if (expiresAtMs > now) {
    readVisibleTime(1_000);
  }
  return now;
}

export function ApprovalCountdown(
  props: Pick<
    SolidJSX.HTMLAttributes<HTMLElement>,
    "class" | "role" | "aria-label" | "aria-hidden" | "title"
  > & { expiresAtMs: number; compact?: boolean },
) {
  const now = createMemo(() => readApprovalTime(props.expiresAtMs));
  return (
    <openclaw-approval-countdown
      style={{ display: "contents" }}
      class={props.class}
      data-urgent={props.expiresAtMs - now() < 60_000 ? "true" : undefined}
      role={props.role}
      aria-label={
        props["aria-label"] ??
        (props.role === "timer" ? approvalRemainingLabel(props.expiresAtMs, now()) : undefined)
      }
      aria-hidden={props["aria-hidden"]}
      title={props.title}
    >
      {props.compact
        ? formatCountdown(props.expiresAtMs, now())
        : approvalRemainingLabel(props.expiresAtMs, now())}
    </openclaw-approval-countdown>
  );
}
