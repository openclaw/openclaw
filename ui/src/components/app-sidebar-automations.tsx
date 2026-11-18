import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, latest, onSettled, Show } from "solid-js";
import type { CronCompactJob } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { registerCronEnglish } from "../i18n/locales/en-cron.ts";
import { automationsFilter } from "../lib/cron/automations-filter.ts";
import { isCronInventoryInvalidation } from "../lib/cron/inventory-connection.ts";
import { readCronInventory } from "../lib/cron/inventory.ts";
import { formatUiError } from "../lib/format-error.ts";
import { createMsFormatter } from "../lib/format.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { formatCronCadence } from "../lib/presenter.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createDocumentVisibility } from "../lib/reactive/platform.ts";
import { createSectionItemsSource, sectionLocation } from "../lib/section-navigation.ts";
import { resolveSessionNavigationAgentId } from "../lib/sessions/route-navigation.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { SidebarListGroup } from "./sidebar-list-group.tsx";
import { Icon } from "./solid/icon.tsx";
import { InlineAlert } from "./solid/inline-alert.tsx";

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

/** The Automations section: New automation, Activity, then active and (collapsed) paused
    automations. */
export function SidebarAutomations(props: {
  host: Pick<AppSidebarRenderHost, "basePath" | "activeRouteId" | "onNavigate">;
}): JSX.Element {
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
  const visible = createDocumentVisibility();
  type Inventory = { jobs: CronCompactJob[]; error: string | null };
  const inventory = createMemo(async (previous?: Inventory): Promise<Inventory> => {
    revision();
    gateway.revision();
    const snapshot = app.gateway.snapshot;
    if (!snapshot.client || !canCallGatewayMethod(snapshot, "cron.list", "operator.read")) {
      return { jobs: [], error: null };
    }
    // The inventory refuses reads for a hidden tab. Keep the rows it showed; returning reads again.
    if (!visible()) {
      return previous ?? { jobs: [], error: null };
    }
    // The sidebar is the only list beside the Automations page, so it reads every page.
    const rows: CronCompactJob[] = [];
    let offset = 0;
    try {
      while (true) {
        const page = await readCronInventory(snapshot.client, {
          includeDisabled: true,
          compact: true,
          limit: 200,
          offset,
          sortBy: "name",
          sortDir: "asc",
        });
        rows.push(...page.jobs);
        if (!page.hasMore || !page.nextOffset || page.nextOffset <= offset) {
          return { jobs: rows, error: null };
        }
        offset = page.nextOffset;
      }
    } catch (error) {
      // A read abandoned because the tab hid or the connection changed is not a failure; the
      // visible or reconnected read that follows replaces it.
      if (error instanceof DOMException && error.name === "AbortError") {
        return previous ?? { jobs: [], error: null };
      }
      return { jobs: [], error: formatUiError(error) };
    }
  });
  // The automations of the filter's agent. Unset follows the agent selected now; automations
  // without one run on the default agent.
  const scoped = createMemo(() => {
    const filterAgentId = automationsFilter().agentId;
    const agentId =
      filterAgentId === null
        ? null
        : normalizeAgentId(filterAgentId ?? resolveSessionNavigationAgentId(app));
    const defaultAgentId = app.agents.state.agentsList?.defaultId;
    return inventory().jobs.filter(
      (job) =>
        agentId === null || normalizeAgentId(job.agentId ?? defaultAgentId ?? agentId) === agentId,
    );
  });
  // With no automation in its agent's scope the section shows only the rail and the page's empty
  // state. An agent picked in the filter keeps the sidebar, so the filter stays in reach.
  const listed = createMemo(
    () =>
      Boolean(inventory().error) ||
      typeof automationsFilter().agentId === "string" ||
      scoped().length > 0,
    { loadingValue: undefined },
  );
  createSectionItemsSource("automations", () => latest(listed));
  // The header's filter narrows and orders the list; sorting stays local to the loaded rows.
  const shown = createMemo(() => {
    const filter = automationsFilter();
    const direction = filter.sortDir === "desc" ? -1 : 1;
    return scoped()
      .filter(
        (job) =>
          (filter.scheduleKind === "all" || job.scheduleKind === filter.scheduleKind) &&
          (filter.lastRun === "all" || (job.lastRunStatus ?? "unknown") === filter.lastRun) &&
          (filter.trigger === "all" || (filter.trigger === "conditional") === Boolean(job.trigger)),
      )
      .toSorted((left, right) => {
        if (filter.sort === "name") {
          return (
            direction *
            (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name)
          );
        }
        const leftMs = left[filter.sort];
        const rightMs = right[filter.sort];
        // Automations without the time sort last in either direction.
        return leftMs == null || rightMs == null
          ? Number(leftMs == null) - Number(rightMs == null)
          : direction * (leftMs - rightMs);
      });
  });
  const activeJobs = () =>
    automationsFilter().status === "paused" ? [] : shown().filter((job) => job.enabled);
  const pausedJobs = () =>
    automationsFilter().status === "active" ? [] : shown().filter((job) => !job.enabled);
  const [activeOpen, setActiveOpen] = createSignal(true);
  const [pausedOpen, setPausedOpen] = createSignal(false);
  // What the page has open, as the page records it for returning to Automations.
  const opened = () =>
    new URLSearchParams(sectionLocation(app.gateway, "automations")?.options.search ?? "");
  const openedJob = () => opened().get("job");
  const activityCurrent = () => props.host.activeRouteId === "cron" && opened().has("activity");
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
  return (
    <nav class="sidebar-automations" aria-label={t("tabs.cron")}>
      <Show when={inventory().error}>
        {(error) => (
          <InlineAlert
            tone="danger"
            action={
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => setRevision((value) => value + 1)}
              >
                {t("common.retry")}
              </button>
            }
          >
            {error()}
          </InlineAlert>
        )}
      </Show>
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
      <a
        class={["nav-item", { "nav-item--active": activityCurrent() }]}
        href={`${cronPath()}?activity`}
        aria-current={activityCurrent() ? "page" : undefined}
        onClick={(event) =>
          handleNavigationClick(event, () =>
            props.host.onNavigate?.("cron", { search: "?activity" }),
          )
        }
      >
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name="activity" />
        </span>
        <span class="nav-item__text">{t("cron.list.runHistory")}</span>
      </a>
      <Show when={activeJobs().length > 0}>
        <SidebarListGroup
          label={t("cron.tabs.active")}
          open={activeOpen()}
          onToggle={() => setActiveOpen(!activeOpen())}
        >
          <For each={activeJobs()}>{(job) => <Row job={job} />}</For>
        </SidebarListGroup>
      </Show>
      <Show when={pausedJobs().length > 0}>
        <SidebarListGroup
          label={t("cron.tabs.paused")}
          // Paused is the one group shown when the filter asks for it.
          open={pausedOpen() || automationsFilter().status === "paused"}
          onToggle={() => setPausedOpen(!pausedOpen())}
        >
          <For each={pausedJobs()}>{(job) => <Row job={job} />}</For>
        </SidebarListGroup>
      </Show>
    </nav>
  );
}
