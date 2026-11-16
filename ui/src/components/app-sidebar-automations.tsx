import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { CronCompactJob } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { registerCronEnglish } from "../i18n/locales/en-cron.ts";
import { automationsFilter } from "../lib/cron/automations-filter.ts";
import { isCronInventoryInvalidation } from "../lib/cron/inventory-connection.ts";
import { readCronInventory } from "../lib/cron/inventory.ts";
import { createMsFormatter } from "../lib/format.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { formatCronCadence } from "../lib/presenter.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { sectionLocation } from "../lib/section-navigation.ts";
import { resolveSessionNavigationAgentId } from "../lib/sessions/route-navigation.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { Icon } from "./solid/icon.tsx";

registerEnglishCatalog(registerCronEnglish);

const formatTimeToday = createMsFormatter({ hour: "numeric", minute: "2-digit" });
const formatLaterDay = createMsFormatter({ month: "short", day: "numeric" });

/** When it runs next, then how often: "Today 5:05 PM · Every 20 minutes", "Nov 21 · Weekly",
    or "Paused · Every 5 hours" once paused. */
function automationByline(job: CronCompactJob): string {
  const cadence = job.schedule ? formatCronCadence({ schedule: job.schedule }) : undefined;
  const nextMs = job.enabled ? job.nextRunAtMs : undefined;
  const next = !job.enabled
    ? t("cron.tabs.paused")
    : nextMs
      ? new Date(nextMs).toDateString() === new Date().toDateString()
        ? t("cron.scheduleLabel.today", { time: formatTimeToday(nextMs) })
        : formatLaterDay(nextMs)
      : undefined;
  return [next, cadence].filter(Boolean).join(" · ");
}

/** The Automations section: New automation, then active and (collapsed) paused automations. */
export function SidebarAutomations(props: { host: AppSidebarRenderHost }): JSX.Element {
  const app = useApplication();
  const gateway = projectGateway(app.gateway);
  const [revision, setRevision] = createSignal(0);
  onSettled(() =>
    app.gateway.subscribeEvents((event) => {
      if (event.event === "cron" || isCronInventoryInvalidation(event, app.gateway.snapshot)) {
        setRevision((value) => value + 1);
      }
    }),
  );
  const jobs = createMemo(async () => {
    revision();
    gateway.revision();
    const snapshot = app.gateway.snapshot;
    if (!snapshot.client || !canCallGatewayMethod(snapshot, "cron.list", "operator.read")) {
      return [];
    }
    // The sidebar is the only list beside the Automations page, so it reads every page.
    const rows: CronCompactJob[] = [];
    let offset = 0;
    while (true) {
      const page = await readCronInventory(snapshot.client, {
        includeDisabled: true,
        compact: true,
        limit: 200,
        offset,
        sortBy: "name",
        sortDir: "asc",
      }).catch(() => null);
      rows.push(...(page?.jobs ?? []));
      if (!page?.hasMore || !page.nextOffset || page.nextOffset <= offset) {
        return rows;
      }
      offset = page.nextOffset;
    }
  });
  // The header's filter narrows and orders the list; sorting stays local to the loaded rows.
  const shown = createMemo(() => {
    const filter = automationsFilter();
    // Unset follows the agent selected now; automations without one run on the default agent.
    const agentId =
      filter.agentId === null
        ? null
        : normalizeAgentId(filter.agentId ?? resolveSessionNavigationAgentId(app));
    const defaultAgentId = app.agents.state.agentsList?.defaultId;
    const order = (job: CronCompactJob) =>
      filter.sort === "nextRunAtMs"
        ? (job.nextRunAtMs ?? Number.POSITIVE_INFINITY)
        : -(job.updatedAtMs ?? 0);
    return jobs()
      .filter(
        (job) =>
          agentId === null ||
          normalizeAgentId(job.agentId ?? defaultAgentId ?? agentId) === agentId,
      )
      .filter(
        (job) =>
          filter.lastRun === "all" ||
          (filter.lastRun === "error" ? job.lastRunStatus === "error" : job.lastRunStatus === "ok"),
      )
      .toSorted((left, right) =>
        filter.sort === "name"
          ? (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name)
          : order(left) - order(right),
      );
  });
  const [activeOpen, setActiveOpen] = createSignal(true);
  const [pausedOpen, setPausedOpen] = createSignal(false);
  // The automation the page has open, as the page records it for returning to Automations.
  const openedJob = () =>
    new URLSearchParams(sectionLocation(app.gateway, "automations")?.options.search ?? "").get(
      "job",
    );
  const cronPath = () => pathForRoute("cron", props.host.basePath);
  const Row = (row: { job: CronCompactJob }) => {
    const href = () => `${cronPath()}?job=${encodeURIComponent(row.job.id)}`;
    const current = () => props.host.activeRouteId === "cron" && openedJob() === row.job.id;
    return (
      <a
        class={["nav-item sidebar-automations__row", { "nav-item--active": current() }]}
        href={href()}
        aria-current={current() ? "page" : undefined}
        onClick={(event) =>
          handleNavigationClick(event, () =>
            props.host.onNavigate?.("cron", { search: `?job=${encodeURIComponent(row.job.id)}` }),
          )
        }
      >
        <span class="sidebar-automations__copy">
          <span class="sidebar-automations__name">{row.job.displayName ?? row.job.name}</span>
          <span class="sidebar-automations__byline">{automationByline(row.job)}</span>
        </span>
        <Show when={row.job.autoDisabled || row.job.lastRunStatus === "error"}>
          <span class="sidebar-automations__failed" role="img" aria-label={t("common.failed")} />
        </Show>
      </a>
    );
  };
  // Group headings share the Sessions sidebar's group heading.
  const Group = (group: {
    label: string;
    jobs: CronCompactJob[];
    open: boolean;
    onToggle: () => void;
  }) => (
    <Show when={group.jobs.length > 0}>
      <div class="sidebar-automations__group" role="group" aria-label={group.label}>
        <div class="sidebar-recent-sessions__head">
          <button
            type="button"
            class="sidebar-session-group-toggle"
            aria-expanded={group.open ? "true" : "false"}
            onClick={() => group.onToggle()}
          >
            <span class="sidebar-session-group-toggle__lead" aria-hidden="true">
              <span class="sidebar-session-group-toggle__icon">
                <Icon name={group.open ? "chevronDown" : "chevronRight"} />
              </span>
            </span>
            <span class="sidebar-recent-sessions__label-text">{group.label}</span>
          </button>
        </div>
        <Show when={group.open}>
          <For each={group.jobs}>{(job) => <Row job={job} />}</For>
        </Show>
      </div>
    </Show>
  );
  return (
    <nav class="sidebar-automations" aria-label={t("tabs.cron")}>
      <a
        class="nav-item sidebar-automations__new"
        href={`${cronPath()}?new`}
        onClick={(event) =>
          handleNavigationClick(event, () => props.host.onNavigate?.("cron", { search: "?new" }))
        }
      >
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name="plus" />
        </span>
        <span class="nav-item__text">{t("cron.list.newTask")}</span>
      </a>
      <Group
        label={t("cron.tabs.active")}
        jobs={automationsFilter().status === "paused" ? [] : shown().filter((job) => job.enabled)}
        open={activeOpen()}
        onToggle={() => setActiveOpen(!activeOpen())}
      />
      <Group
        label={t("cron.tabs.paused")}
        jobs={automationsFilter().status === "active" ? [] : shown().filter((job) => !job.enabled)}
        // Paused is the one group shown when the filter asks for it.
        open={pausedOpen() || automationsFilter().status === "paused"}
        onToggle={() => setPausedOpen(!pausedOpen())}
      />
    </nav>
  );
}
