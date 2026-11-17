import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { CronCompactJob } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { registerCronEnglish } from "../i18n/locales/en-cron.ts";
import { isCronInventoryInvalidation } from "../lib/cron/inventory-connection.ts";
import { readCronInventory } from "../lib/cron/inventory.ts";
import { formatCompactMs } from "../lib/format.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { formatCronSchedule } from "../lib/presenter.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { Icon } from "./solid/icon.tsx";

registerEnglishCatalog(registerCronEnglish);

function automationByline(job: CronCompactJob): string {
  const schedule = job.schedule ? formatCronSchedule({ schedule: job.schedule }) : undefined;
  if (!job.enabled) {
    return schedule ?? "";
  }
  const failed = job.autoDisabled || job.lastRunStatus === "error";
  const next = job.nextRunAtMs ? formatCompactMs(job.nextRunAtMs) : undefined;
  return [failed ? t("common.failed") : undefined, next, schedule].filter(Boolean).join(" · ");
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
    const result = await readCronInventory(snapshot.client, {
      includeDisabled: true,
      compact: true,
      limit: 200,
      offset: 0,
      sortBy: "name",
      sortDir: "asc",
    }).catch(() => null);
    return result?.jobs ?? [];
  });
  const [pausedOpen, setPausedOpen] = createSignal(false);
  // The sidebar learns the route, not its query, so it keeps the job it last opened.
  const [selected, setSelected] = createSignal(
    new URLSearchParams(window.location.search).get("job"),
  );
  const cronPath = () => pathForRoute("cron", props.host.basePath);
  const Row = (row: { job: CronCompactJob }) => {
    const href = () => `${cronPath()}?job=${encodeURIComponent(row.job.id)}`;
    const current = () => props.host.activeRouteId === "cron" && selected() === row.job.id;
    return (
      <a
        class={["nav-item sidebar-automations__row", { "nav-item--active": current() }]}
        href={href()}
        aria-current={current() ? "page" : undefined}
        onClick={(event) =>
          handleNavigationClick(event, () => {
            setSelected(row.job.id);
            props.host.onNavigate?.("cron", { search: `?job=${encodeURIComponent(row.job.id)}` });
          })
        }
      >
        <span class="sidebar-automations__name">{row.job.displayName ?? row.job.name}</span>
        <span class="sidebar-automations__byline">{automationByline(row.job)}</span>
      </a>
    );
  };
  return (
    <nav class="sidebar-automations" aria-label={t("tabs.cron")}>
      <a
        class="nav-item sidebar-automations__new"
        href={`${cronPath()}?new`}
        onClick={(event) =>
          handleNavigationClick(event, () => {
            setSelected(null);
            props.host.onNavigate?.("cron", { search: "?new" });
          })
        }
      >
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name="plus" />
        </span>
        <span class="nav-item__text">{t("cron.list.newTask")}</span>
      </a>
      <div class="sidebar-automations__group" role="group" aria-label={t("cron.tabs.active")}>
        <span class="sidebar-automations__heading">{t("cron.tabs.active")}</span>
        <For each={jobs().filter((job) => job.enabled)}>{(job) => <Row job={job} />}</For>
      </div>
      <Show when={jobs().some((job) => !job.enabled)}>
        <div class="sidebar-automations__group" role="group" aria-label={t("cron.tabs.paused")}>
          <button
            type="button"
            class="sidebar-automations__heading sidebar-automations__toggle"
            aria-expanded={pausedOpen() ? "true" : "false"}
            onClick={() => setPausedOpen(!pausedOpen())}
          >
            <Icon name={pausedOpen() ? "chevronDown" : "chevronRight"} />
            {t("cron.tabs.paused")}
          </button>
          <Show when={pausedOpen()}>
            <For each={jobs().filter((job) => !job.enabled)}>{(job) => <Row job={job} />}</For>
          </Show>
        </div>
      </Show>
    </nav>
  );
}
