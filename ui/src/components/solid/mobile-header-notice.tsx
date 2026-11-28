import { Show } from "solid-js";
import type { GatewayStatus } from "../../lib/gateway-status.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "./icon.tsx";

export type MobileHeaderNoticeContent =
  | { kind: "gateway"; status: GatewayStatus; onRetry?: () => void }
  | {
      kind: "device-offline";
      deviceName: string;
      onOpenMachine: (source: HTMLElement) => void;
    };

export function MobileHeaderNotice(props: { notice: MobileHeaderNoticeContent }) {
  return (
    <div
      class="mobile-header__notices"
      role={props.notice.kind === "device-offline" ? "status" : undefined}
      aria-live={props.notice.kind === "device-offline" ? "polite" : undefined}
    >
      <Show when={props.notice.kind === "device-offline" ? props.notice : undefined}>
        {(notice) => (
          <button
            type="button"
            class="mobile-header__notice mobile-header__machine"
            onClick={(event) => notice().onOpenMachine(event.currentTarget)}
          >
            <Icon name="monitor" />
            <span class="mobile-header__device-name">{notice().deviceName}</span>
            <span>{t("common.offline")}</span>
            <Icon name="chevronRight" />
          </button>
        )}
      </Show>
      <Show when={props.notice.kind === "gateway" ? props.notice : undefined}>
        {(notice) => (
          <span class="mobile-header__notice">
            <Show when={notice().status !== "offline" && notice().status !== "reload-required"}>
              <Icon
                name={
                  notice().status === "suspended" || notice().status === "suspending"
                    ? "pause"
                    : "loader"
                }
                class={
                  notice().status === "suspended" || notice().status === "suspending"
                    ? undefined
                    : "mobile-header__spinner"
                }
              />
            </Show>
            <span>{t(`connection.${notice().status}`)}</span>
            <Show when={notice().status === "offline" && notice().onRetry}>
              <span class="mobile-header__notice-divider" aria-hidden="true" />
              <button
                type="button"
                class="mobile-header__retry"
                aria-label={t("connection.retryNow")}
                onClick={() => notice().onRetry?.()}
              >
                {t("common.retry")}
              </button>
            </Show>
          </span>
        )}
      </Show>
    </div>
  );
}
