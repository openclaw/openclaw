import type { SkillsWorkshopListResult } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import { titleForRoute, type NavigationRouteId } from "../app-navigation.ts";
import {
  pathForPluginSettings,
  pathForRoute,
  pathForTemplateCatalogEntry,
} from "../app-route-paths.ts";
import { registerSkillWorkshopEnglish } from "../i18n/locales/en-skill-workshop.ts";
import { registerSkillsBrowserEnglish } from "../i18n/locales/en-skills-browser.ts";
import { registerTemplatesEnglish } from "../i18n/locales/en-templates.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { loadPluginCatalog } from "../lib/plugins/index.ts";
import { projectAgentSelection, projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { resolveSessionNavigationAgentId } from "../lib/sessions/route-navigation.ts";
import { loadSkillStatusReport } from "../lib/skills/status-report.ts";
import { readTemplatesOverview } from "../pages/agents-home/templates-catalog-client.ts";
import { PluginIconOwner, pluginIconFetchContext } from "../pages/plugins/plugin-icon-owner.ts";
import { pluginFallbackGradient, pluginMonogram } from "../pages/plugins/presentation.ts";
import { isSkillWorkshopInstalled } from "../pages/skill-workshop/access.ts";
import { renderSidebarNavLink as SidebarNavLink } from "./app-sidebar-nav-menus.tsx";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { IconName } from "./icon-data.ts";
import { Icon } from "./solid/icon.tsx";

registerEnglishCatalog(registerSkillsBrowserEnglish);
registerEnglishCatalog(registerSkillWorkshopEnglish);
registerEnglishCatalog(registerTemplatesEnglish);

const CUSTOMIZE_PAGES: ReadonlyArray<readonly [NavigationRouteId, IconName, string]> = [
  ["plugins", "plug", "tabs.plugins"],
  ["skills", "sparkles", "tabs.skills"],
  ["skill-workshop", "wandSparkles", "tabs.skillWorkshop"],
  ["templates", "blobster", "tabs.templates"],
];

type ListProps = { host: AppSidebarRenderHost };

/** One titled list under the page rows; it stays hidden until it has rows. */
function CustomizeGroup(props: { label: string; count: number; children: JSX.Element }) {
  return (
    <Show when={props.count > 0}>
      <div class="sidebar-customize__group" role="group" aria-label={props.label}>
        <span class="sidebar-customize__heading">{props.label}</span>
        {props.children}
      </div>
    </Show>
  );
}

/** The sidebar learns the route, not its query, so a list keeps the row it last opened. */
function createOpenedRow(param: string) {
  return createSignal(new URLSearchParams(window.location.search).get(param));
}

/** A plugin's icon, or the Plugins page's gradient monogram while it has none. */
function PluginIcon(props: { id: string; name: string; url?: string }) {
  const gradient = () => pluginFallbackGradient(props.id);
  return (
    <Show
      when={props.url}
      fallback={
        <span
          class="sidebar-customize__plugin-icon sidebar-customize__plugin-icon--fallback"
          style={{ "--plugins-art-a": gradient()[0], "--plugins-art-b": gradient()[1] }}
          aria-hidden="true"
        >
          {pluginMonogram(props.name).slice(0, 1)}
        </span>
      }
    >
      {(url) => <img class="sidebar-customize__plugin-icon" src={url()} alt="" />}
    </Show>
  );
}

/** On Plugins: every installed plugin, each opening its settings page. */
function CustomizePlugins(props: ListProps) {
  const app = useApplication();
  const gateway = projectGateway(app.gateway);
  const [revision, setRevision] = createSignal(0);
  const [iconUrls, setIconUrls] = createSignal<Record<string, string>>({});
  let mounted = true;
  const icons = new PluginIconOwner({
    getFetchContext: () => pluginIconFetchContext(app),
    isConnected: () => mounted,
    onUrlsChange: setIconUrls,
  });
  onSettled(() => () => {
    mounted = false;
    icons.reset();
  });
  onSettled(() =>
    app.gateway.subscribeEvents((event) => {
      if (event.event === "plugins.changed") {
        setRevision((value) => value + 1);
      }
    }),
  );
  const installed = createMemo(async () => {
    revision();
    gateway.revision();
    const snapshot = app.gateway.snapshot;
    if (!snapshot.client || !canCallGatewayMethod(snapshot, "plugins.list", "operator.read")) {
      return [];
    }
    const result = await loadPluginCatalog(snapshot.client).catch(() => null);
    const plugins = (result?.plugins ?? [])
      .filter((plugin) => plugin.installed)
      .toSorted((left, right) => left.name.localeCompare(right.name));
    // Each listed plugin shows its own icon, read the way the Plugins page reads it.
    const withIcons = plugins.filter((plugin) => plugin.hasIcon).map((plugin) => plugin.id);
    icons.reconcileKeys(new Set(withIcons));
    for (const id of withIcons) {
      icons.load(id);
    }
    return plugins;
  });
  return (
    <CustomizeGroup label={t("pluginsPage.installed")} count={installed().length}>
      <For each={installed()}>
        {(plugin) => (
          // An installed plugin's page is its settings page; "from" returns it to Plugins.
          <SidebarNavLink
            href={`${pathForPluginSettings(plugin.id, props.host.basePath)}?from=plugins`}
            active={false}
            icon={<PluginIcon id={plugin.id} name={plugin.name} url={iconUrls()[plugin.id]} />}
            label={plugin.name}
            onNavigate={() =>
              props.host.onNavigate?.("plugin-settings", {
                pathname: pathForPluginSettings(plugin.id, props.host.basePath),
                search: "?from=plugins",
              })
            }
          />
        )}
      </For>
    </CustomizeGroup>
  );
}

/** On Skills: the selected agent's installed skills, each opening its details. */
function CustomizeSkills(props: ListProps) {
  const app = useApplication();
  const gateway = projectGateway(app.gateway);
  const selection = projectAgentSelection(app.agentSelection);
  const [opened, setOpened] = createOpenedRow("skill");
  const skills = createMemo(async () => {
    gateway.revision();
    selection.revision();
    const snapshot = app.gateway.snapshot;
    if (!snapshot.client || !canCallGatewayMethod(snapshot, "skills.status", "operator.read")) {
      return [];
    }
    const agentId = resolveSessionNavigationAgentId(app);
    const report = await loadSkillStatusReport(snapshot.client, agentId).catch(() => undefined);
    return (report?.skills ?? []).toSorted((left, right) => left.name.localeCompare(right.name));
  });
  return (
    <CustomizeGroup label={t("skillsPage.installed")} count={skills().length}>
      <For each={skills()}>
        {(skill) => {
          const search = `?skill=${encodeURIComponent(skill.skillKey)}`;
          return (
            <SidebarNavLink
              href={`${pathForRoute("skills", props.host.basePath)}${search}`}
              active={props.host.activeRouteId === "skills" && opened() === skill.skillKey}
              icon={
                skill.emoji ? (
                  <span class="sidebar-customize__emoji" aria-hidden="true">
                    {skill.emoji}
                  </span>
                ) : (
                  <Icon name="sparkles" />
                )
              }
              label={skill.name}
              onNavigate={() => {
                setOpened(skill.skillKey);
                props.host.onNavigate?.("skills", { search });
              }}
            />
          );
        }}
      </For>
    </CustomizeGroup>
  );
}

/** On Skill workshop: the skills the agent has learned, each opening in the Workshop. */
function CustomizeWorkshop(props: ListProps) {
  const app = useApplication();
  const gateway = projectGateway(app.gateway);
  const selection = projectAgentSelection(app.agentSelection);
  const [opened, setOpened] = createOpenedRow("skill");
  const learned = createMemo(async () => {
    gateway.revision();
    selection.revision();
    const snapshot = app.gateway.snapshot;
    if (
      !snapshot.client ||
      !isSkillWorkshopInstalled(snapshot) ||
      !canCallGatewayMethod(snapshot, "skills.workshop.list", "operator.read")
    ) {
      return [];
    }
    const list = await snapshot.client
      .request<SkillsWorkshopListResult>("skills.workshop.list", {
        agentId: resolveSessionNavigationAgentId(app),
      })
      .catch(() => null);
    return (list?.skills ?? []).toSorted((left, right) => left.name.localeCompare(right.name));
  });
  return (
    <CustomizeGroup label={t("skillWorkshop.skills.title")} count={learned().length}>
      <For each={learned()}>
        {(skill) => {
          const search = `?skill=${encodeURIComponent(skill.name)}`;
          return (
            <SidebarNavLink
              href={`${pathForRoute("skill-workshop", props.host.basePath)}${search}`}
              active={props.host.activeRouteId === "skill-workshop" && opened() === skill.name}
              icon={<Icon name="wandSparkles" />}
              label={skill.name}
              onNavigate={() => {
                setOpened(skill.name);
                props.host.onNavigate?.("skill-workshop", { search });
              }}
            />
          );
        }}
      </For>
    </CustomizeGroup>
  );
}

/** On Templates: the catalog's featured templates, each opening its details. */
function CustomizeTemplates(props: ListProps) {
  const app = useApplication();
  const gateway = projectGateway(app.gateway);
  const featured = createMemo(async () => {
    gateway.revision();
    const snapshot = app.gateway.snapshot;
    if (
      !snapshot.client ||
      !canCallGatewayMethod(snapshot, "templates.catalog.search", "operator.read")
    ) {
      return [];
    }
    const overview = await readTemplatesOverview(snapshot.client, 12).catch(() => undefined);
    return overview?.featured ?? [];
  });
  return (
    <CustomizeGroup label={t("templatesCatalog.featured")} count={featured().length}>
      <For each={featured()}>
        {(template) => {
          const pathname = pathForTemplateCatalogEntry(template.packageName, props.host.basePath);
          return (
            <SidebarNavLink
              href={pathname}
              active={false}
              icon={
                template.iconUrl ? (
                  <img class="sidebar-customize__plugin-icon" src={template.iconUrl} alt="" />
                ) : (
                  <Icon name="blobster" />
                )
              }
              label={template.displayName}
              onNavigate={() => props.host.onNavigate?.("templates", { pathname })}
            />
          );
        }}
      </For>
    </CustomizeGroup>
  );
}

/** The Customize section: its pages, then the open page's own list. */
export function SidebarCustomize(props: { host: AppSidebarRenderHost }): JSX.Element {
  // Enabled routes leave out Templates unless its experimental flag is on.
  const pages = () =>
    CUSTOMIZE_PAGES.filter(([route]) => props.host.enabledRouteIds?.includes(route) ?? true);
  const route = () => props.host.activeRouteId;
  return (
    <nav class="sidebar-customize" aria-label={titleForRoute("plugins", t)}>
      <For each={pages()}>
        {(page) => {
          const [pageRoute, icon, label] = page;
          const active = () => route() === pageRoute;
          return (
            <SidebarNavLink
              href={pathForRoute(pageRoute, props.host.basePath)}
              active={active()}
              icon={<Icon name={icon} filled={active()} />}
              label={t(label)}
              onNavigate={() => props.host.onNavigate?.(pageRoute)}
            />
          );
        }}
      </For>
      <Switch>
        <Match when={route() === "skills"}>
          <CustomizeSkills host={props.host} />
        </Match>
        <Match when={route() === "skill-workshop"}>
          <CustomizeWorkshop host={props.host} />
        </Match>
        <Match when={route() === "templates"}>
          <CustomizeTemplates host={props.host} />
        </Match>
        <Match when={route() === "plugins" || route() === "plugin-settings"}>
          <CustomizePlugins host={props.host} />
        </Match>
      </Switch>
    </nav>
  );
}
