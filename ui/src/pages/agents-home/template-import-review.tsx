import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { TabPanel, Tabs } from "../../components/solid/tabs.tsx";
import { registerTemplatesEnglish } from "../../i18n/locales/en-templates.ts";
import { formatCronSchedule } from "../../lib/presenter.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { TemplateArtwork } from "./template-artwork.tsx";
import { structuredTemplateFields, templateImportFacts } from "./template-import-facts.ts";
import type { TemplateAddReviewPlan } from "./templates-catalog-client.ts";

registerEnglishCatalog(registerTemplatesEnglish);

function CapabilityRow(props: {
  group: string;
  icon: IconName;
  title: string;
  description: string;
  children: JSX.Element;
}) {
  return (
    <details name={props.group} class="settings-disclosure template-import-capability">
      <summary class="settings-row settings-row--nav settings-disclosure__summary">
        <span class="template-import-capability__icon" aria-hidden="true">
          <Icon name={props.icon} />
        </span>
        <span class="settings-row__text oc-settings-row-content">
          <span class="settings-row__title oc-settings-row-title">{props.title}</span>
          <span class="settings-row__desc oc-settings-row-description">{props.description}</span>
        </span>
        <span class="settings-row__chevron settings-disclosure__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <div class="template-import-capability__details">{props.children}</div>
    </details>
  );
}

function Configuration(props: { value: unknown }) {
  const fields = createMemo(() => structuredTemplateFields(props.value));
  return (
    <dl class="template-import-fields">
      <For each={fields()}>
        {([key, value]) => (
          <div>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

function scheduleSummary(job: ReturnType<typeof templateImportFacts>["schedules"][number]) {
  const proposed = job.proposed;
  if (!proposed) {
    return job.action;
  }
  const schedule = proposed.schedule;
  const clock =
    "cron" in schedule ? /^(\d{1,2}) (\d{1,2}) \* \* (?:\*|1-5)$/.exec(schedule.cron) : null;
  const summary = clock
    ? new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(2000, 0, 1, Number(clock[2]), Number(clock[1]))))
    : "cron" in schedule
      ? formatCronSchedule({ schedule: { kind: "cron", expr: schedule.cron } })
      : formatCronSchedule({ schedule: { kind: "every", everyMs: schedule.everyMs } });
  const zone =
    "timezone" in schedule ? schedule.timezone.split("/").at(-1)?.replaceAll("_", " ") : undefined;
  const delivery =
    proposed.delivery === "none" ? t("templatesCatalog.importPrivate") : proposed.delivery;
  return [summary, zone, delivery].filter(Boolean).join(" · ");
}

function scheduleTitle(job: ReturnType<typeof templateImportFacts>["schedules"][number]) {
  const schedule = job.proposed?.schedule;
  return schedule &&
    "cron" in schedule &&
    /^\d+ \d+ \* \* 1-5$/.test(schedule.cron) &&
    /brief/i.test(job.name)
    ? t("templatesCatalog.importWeekdayBriefing")
    : job.name;
}

export function TemplateImportReview(props: { plan: TemplateAddReviewPlan }) {
  const facts = createMemo(() => templateImportFacts(props.plan));
  const [tab, setTab] = createSignal("overview");
  const id = createUniqueId();
  const source = () => props.plan.manifestDisclosure?.source;
  const shortFiles = () =>
    facts().fileNames.length > 2
      ? t("templatesCatalog.importMore", {
          names: facts().fileNames.slice(0, 2).join(", "),
          count: String(facts().fileNames.length - 2),
        })
      : facts().fileNames.join(", ");
  return (
    <div class="template-import-review">
      <div class="template-import-identity">
        <span class="template-import-identity__icon" aria-hidden="true">
          <TemplateArtwork />
        </span>
        <div>
          <h3>{facts().name}</h3>
          <Show when={tab() === "overview" && facts().description}>
            <p class="template-import-identity__description">{facts().description}</p>
          </Show>
        </div>
      </div>
      <Tabs
        class="template-import-tabs"
        active={tab()}
        onSelect={(value) => {
          setTab(value);
        }}
        ariaLabel={t("templatesCatalog.importReview")}
        items={[
          {
            value: "overview",
            label: t("templatesCatalog.importOverview"),
            id: id + "-overview-tab",
            panelId: id + "-overview",
          },
          {
            value: "details",
            label: t("templatesCatalog.importDetails"),
            id: id + "-details-tab",
            panelId: id + "-details",
          },
        ]}
      />
      <TabPanel id={id + "-overview"} tabId={id + "-overview-tab"} active={tab() === "overview"}>
        <div class="template-import-surface template-import-capabilities">
          <Show when={facts().files.length}>
            <CapabilityRow
              group={id}
              icon="fileText"
              title={t("templatesCatalog.importFiles", { count: String(facts().files.length) })}
              description={shortFiles()}
            >
              <ul>
                <For each={facts().fileNames}>{(name) => <li>{name}</li>}</For>
              </ul>
            </CapabilityRow>
          </Show>
          <Show when={facts().skills.length}>
            <CapabilityRow
              group={id}
              icon="book"
              title={
                facts().skills.length === 1
                  ? t("templatesCatalog.importSkill")
                  : t("templatesCatalog.importSkills", { count: String(facts().skills.length) })
              }
              description={facts()
                .skills.map((skill) => skill.ref.split("/").at(-1))
                .join(" · ")}
            >
              <ul>
                <For each={facts().skills}>
                  {(skill) => (
                    <li>
                      {skill.ref} ·{" "}
                      {t("templatesCatalog.importVersion", { version: skill.version })} ·{" "}
                      {skill.action}
                    </li>
                  )}
                </For>
              </ul>
            </CapabilityRow>
          </Show>
          <Show when={props.plan.pluginReviews.length}>
            <CapabilityRow
              group={id}
              icon="plug"
              title={
                props.plan.pluginReviews.length === 1
                  ? t("templatesCatalog.importPlugin")
                  : t("templatesCatalog.importPlugins", {
                      count: String(props.plan.pluginReviews.length),
                    })
              }
              description={props.plan.pluginReviews
                .map((plugin) => plugin.ref.split("/").at(-1))
                .join(" · ")}
            >
              <ul>
                <For each={props.plan.pluginReviews}>
                  {(plugin) => (
                    <li>
                      {plugin.ref} ·{" "}
                      {t("templatesCatalog.importVersion", { version: plugin.version })} ·{" "}
                      {plugin.ownerAction}
                    </li>
                  )}
                </For>
              </ul>
            </CapabilityRow>
          </Show>
          <Show when={facts().mcpServers.length}>
            <CapabilityRow
              group={id}
              icon="plug"
              title={t("templatesCatalog.importMcpServers", {
                count: String(facts().mcpServers.length),
              })}
              description={facts()
                .mcpServers.map((server) => server.id)
                .join(" · ")}
            >
              <For each={facts().mcpServers}>{(server) => <Configuration value={server} />}</For>
            </CapabilityRow>
          </Show>
          <For each={facts().schedules}>
            {(job) => (
              <CapabilityRow
                group={id}
                icon="clock"
                title={scheduleTitle(job)}
                description={scheduleSummary(job)}
              >
                <Configuration value={{ name: job.name, action: job.action, ...job.proposed }} />
              </CapabilityRow>
            )}
          </For>
          <Show when={facts().requestedTools.length}>
            <CapabilityRow
              group={id}
              icon="terminal"
              title={t(
                facts().requestsExec
                  ? "templatesCatalog.importExec"
                  : "templatesCatalog.importTools",
              )}
              description={
                facts().requestsExec
                  ? t("templatesCatalog.importExecSummary")
                  : facts().requestedTools.join(" · ")
              }
            >
              <Configuration
                value={{
                  profile: facts().toolProfile,
                  requested: facts().requestedTools,
                  workspaceOnly: facts().workspaceOnly,
                }}
              />
              <p>{t("templatesCatalog.importAccessNote")}</p>
              <Show when={facts().workspaceOnly && facts().requestsExec}>
                <p>{t("templatesCatalog.importFsNote")}</p>
              </Show>
            </CapabilityRow>
          </Show>
        </div>
      </TabPanel>
      <TabPanel id={id + "-details"} tabId={id + "-details-tab"} active={tab() === "details"}>
        <div class="template-import-surface template-import-detail-content">
          <Show when={facts().description}>
            <p>{facts().description}</p>
          </Show>
          <Configuration
            value={{
              package: source()?.packageName,
              version: source()?.version ?? props.plan.target.targetVersion,
              agent: props.plan.target.agentId,
              workspace: props.plan.target.workspace,
            }}
          />
          <details class="template-import-configuration">
            <summary>{t("templatesCatalog.importConfiguration")}</summary>
            <p>{t("templatesCatalog.importAccessNote")}</p>
            <Configuration value={props.plan.configuredAccess} />
            <For each={props.plan.capabilities}>{(capability) => <p>{capability.reason}</p>}</For>
          </details>
          <details class="template-import-configuration">
            <summary>{t("templatesCatalog.importRaw")}</summary>
            <pre>{JSON.stringify(props.plan, null, 2)}</pre>
          </details>
        </div>
      </TabPanel>
    </div>
  );
}
