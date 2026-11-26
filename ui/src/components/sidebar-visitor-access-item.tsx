import { Show } from "solid-js";
import { formatDateTimeMs } from "../lib/format.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { VisitorAccessNotice } from "./sidebar-attention-entries.ts";
import { SidebarNotificationCard } from "./sidebar-notification-card.tsx";
import { Icon } from "./solid/icon.tsx";

export function SidebarVisitorAccessItem(props: {
  notice: VisitorAccessNotice;
  onDismiss: () => void;
}) {
  const detail = () => {
    const expiresAt = props.notice.expiresAt;
    return expiresAt === null
      ? t("attention.visitorAccess.noExpiry")
      : t("attention.visitorAccess.expires", {
          date: formatDateTimeMs(expiresAt, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }),
        });
  };
  return (
    <SidebarNotificationCard
      title={t(
        props.notice.kind === "restored"
          ? "attention.visitorAccess.restored"
          : "attention.visitorAccess.extended",
      )}
      detail={detail()}
      icon={<Icon name="key" />}
      timestampMs={props.notice.createdAt}
      onDismiss={props.onDismiss}
      body={
        <>
          <p>{detail()}</p>
          <Show when={props.notice.note}>{(note) => <p>{note()}</p>}</Show>
        </>
      }
    />
  );
}
