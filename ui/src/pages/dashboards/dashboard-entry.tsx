import type { JSX } from "@solidjs/web";
import { Show, createMemo } from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { renderSessionOwnerChip } from "../../components/solid/session-presentation.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import type { SessionCreatedActor } from "../../lib/session-owner.ts";
import {
  isSessionKeyAddressable,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { HoverMarquee } from "../../lib/solid/hover-marquee.tsx";
import { DashboardPreview } from "./dashboard-preview.tsx";
import type {
  DashboardGalleryFilters,
  DashboardGalleryHandlers,
  DashboardsRouteData,
} from "./gallery-filters.ts";

export type DashboardRow = SessionsListResult["sessions"][number];

export function dashboardAuthor(row: DashboardRow, fallbackAgentId: string) {
  const actor = row.createdActor ?? row.owner?.actor;
  const id = actor?.id?.trim() || row.agentId?.trim() || fallbackAgentId;
  const label = actor?.label?.trim() || id;
  // Without an actor id the author is the session's agent, drawn with its agent avatar.
  const avatar: SessionCreatedActor = actor?.id?.trim()
    ? actor
    : { type: "agent", id, label, identity: { type: "agent", id } };
  return { id, label, avatar };
}

type DashboardGroup = { key: string; label?: JSX.Element; rows: DashboardRow[] };

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dashboardGroups(
  data: DashboardsRouteData,
  rows: DashboardRow[],
  group: DashboardGalleryFilters["group"],
  selfId: string | undefined,
): DashboardGroup[] {
  if (group === "updated") {
    const today = startOfDay(Date.now());
    const week = today - 6 * 24 * 60 * 60 * 1000;
    const bucket = (row: DashboardRow) =>
      (row.updatedAt ?? 0) >= today ? "today" : (row.updatedAt ?? 0) >= week ? "week" : "earlier";
    return (["today", "week", "earlier"] as const)
      .map((key) => ({
        key,
        label: t(
          key === "today"
            ? "dashboardsPage.groupToday"
            : key === "week"
              ? "dashboardsPage.groupThisWeek"
              : "dashboardsPage.groupEarlier",
        ),
        rows: rows.filter((row) => bucket(row) === key),
      }))
      .filter((entry) => entry.rows.length > 0);
  }
  if (group === "author") {
    const groups = new Map<string, DashboardGroup>();
    for (const row of rows) {
      const author = dashboardAuthor(row, data.fallbackAgentId);
      const known = groups.get(author.id);
      if (known) {
        known.rows.push(row);
      } else {
        groups.set(author.id, {
          key: author.id,
          label: (
            <>
              {renderSessionOwnerChip(author.avatar, "row")}
              <span>{author.id === selfId ? t("dashboardsPage.you") : author.label}</span>
            </>
          ),
          rows: [row],
        });
      }
    }
    return [...groups.values()];
  }
  return [{ key: "all", rows }];
}

type DashboardEntryProps = {
  data: DashboardsRouteData;
  row: DashboardRow;
  handlers: DashboardGalleryHandlers;
  gatewaySnapshot?: ApplicationGatewaySnapshot;
  variant: "card" | "row";
  contentRef?: (element: HTMLElement) => void;
};

/** One dashboard as a grid card or a list row; both share the title, author and time treatment. */
export function DashboardEntry(props: DashboardEntryProps) {
  const target = createMemo(() =>
    isSessionKeyAddressable(props.row.key, props.data.globalScope)
      ? sessionNavigationTarget({
          face: "dashboard",
          sessionKey: props.row.key,
          fallbackAgentId:
            props.row.key === "global"
              ? props.row.agentId?.trim() || props.data.fallbackAgentId
              : props.data.fallbackAgentId,
          basePath: props.data.basePath,
          row: props.row,
          mainKey: props.data.mainKey,
        })
      : null,
  );
  const author = () => dashboardAuthor(props.row, props.data.fallbackAgentId);
  const authorName = () =>
    author().id === props.gatewaySnapshot?.selfUser?.id ? t("dashboardsPage.you") : author().label;
  const title = createMemo(() => resolveSessionDisplayName(props.row.key, props.row));
  const running = () => props.row.status === "running";
  const prefix = () => (props.variant === "row" ? "dashboard-row" : "dashboard-card");
  let entry!: HTMLElement;
  const preview = () => (
    <DashboardPreview
      gatewaySnapshot={props.gatewaySnapshot}
      sessionKey={props.row.key}
      agentId={props.row.agentId}
    />
  );
  const spinner = () => (
    <span
      class="session-run-spinner"
      role="img"
      aria-label={t("dashboardsPage.running")}
      title={t("dashboardsPage.running")}
    />
  );
  const titleText = () => (
    <HoverMarquee
      content={title()}
      class="dashboard-card__title"
      options={{ loop: true, host: () => entry }}
    />
  );
  const authorLine = () => (
    <>
      {renderSessionOwnerChip(author().avatar, "row")}
      <HoverMarquee
        content={t("dashboardsPage.byAuthor", { author: authorName() })}
        class="dashboard-card__author-name"
        options={{ stationary: true, host: () => entry }}
      />
    </>
  );
  const updated = () => (
    <Show when={props.row.updatedAt} fallback={t("dashboardsPage.updatedUnknown")}>
      {(updatedAt) => (
        <>
          <span class="dashboard-card__updated-label">{t("dashboardsPage.updatedLabel")}</span>{" "}
          <span class="dashboard-card__updated-time">{formatRelativeTimestamp(updatedAt())}</span>
        </>
      )}
    </Show>
  );
  const Content = () => (
    <Show
      when={props.variant === "row"}
      fallback={
        <>
          <div class="dashboard-preview" aria-hidden="true" inert>
            <div class="dashboard-preview__sheet">{preview()}</div>
          </div>
          <div class="dashboard-card__body">
            <div class="dashboard-card__heading">
              <h2>{titleText()}</h2>
              {/* Reserved even while idle, so a run starting never shifts the title. */}
              <span class="dashboard-card__status">
                <Show when={running()}>{spinner()}</Show>
              </span>
            </div>
            <div class="dashboard-card__meta">
              <span class="dashboard-card__author">{authorLine()}</span>
              <span class="dashboard-card__updated">{updated()}</span>
            </div>
          </div>
        </>
      }
    >
      <>
        <div class="dashboard-row__thumb" aria-hidden="true" inert>
          <div class="dashboard-row__canvas">{preview()}</div>
        </div>
        {/* In a row the spinner follows the title instead of holding the row's end. */}
        <div class="dashboard-row__title">
          <h2>{titleText()}</h2>
          <Show when={running()}>{spinner()}</Show>
        </div>
        <div class="dashboard-row__author dashboard-card__author">{authorLine()}</div>
        <div class="dashboard-row__updated dashboard-card__updated">{updated()}</div>
      </>
    </Show>
  );
  return (
    <article
      ref={(element) => (entry = element)}
      class={prefix()}
      data-dashboard-session={props.row.key}
    >
      <Show
        when={target()}
        fallback={
          <div class={`${prefix()}__main`} ref={(element) => props.contentRef?.(element)}>
            <Content />
          </div>
        }
      >
        {(destination) => (
          <a
            ref={(element) => props.contentRef?.(element)}
            class={`${prefix()}__main`}
            href={destination().href}
            aria-label={title()}
            onClick={(event: MouseEvent) => {
              const current = target();
              if (current && props.handlers.onNavigate && shouldHandleNavigationClick(event)) {
                event.preventDefault();
                props.handlers.onNavigate("dashboard", current.options);
              }
            }}
          >
            <Content />
          </a>
        )}
      </Show>
    </article>
  );
}
