import "../../styles/skill-page.css";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import {
  renderPluginDetailBreadcrumb,
  renderPluginDetailShell as PluginDetailShell,
} from "../plugins/detail-shell.tsx";
import { SkillPageLoading } from "./skill-page-boundary.tsx";
import type { SkillsProps } from "./view-types.ts";

/**
 * A skill's page has the plugin page's layout: the way back, the header with its actions, the
 * reading column, and the facts in a rail.
 */
export function SkillPageShell(props: {
  view: SkillsProps;
  name: string;
  icon: JSX.Element;
  identity?: JSX.Element;
  actions?: JSX.Element;
  notices?: JSX.Element;
  summary?: string;
  panel: JSX.Element;
  facts: JSX.Element;
}) {
  return (
    <div class="skill-page">
      <PluginDetailShell
        id="skill-page"
        name={props.name}
        summary={props.summary}
        backHref={props.view.listHref}
        backLabel={t("tabs.skills")}
        onBack={() => props.view.onDetailClose()}
        icon={props.icon}
        identity={
          <Show when={props.identity}>
            <div class="plugin-catalog-detail__publisher skill-page__byline">{props.identity}</div>
          </Show>
        }
        titleAction={props.actions}
        notices={props.notices}
        panel={props.panel}
        sidebar={props.facts}
        rail
      />
    </div>
  );
}

/** A skill page with nothing to show yet, or nothing at this address: the way back stays. */
export function SkillPageAbsent(props: {
  view: SkillsProps;
  name: string;
  pending: boolean;
  message?: JSX.Element;
}) {
  const breadcrumb = () =>
    renderPluginDetailBreadcrumb({
      name: props.name,
      backHref: props.view.listHref,
      backLabel: t("tabs.skills"),
      onBack: () => props.view.onDetailClose(),
    });
  return (
    <Show when={!props.pending} fallback={<SkillPageLoading breadcrumb={breadcrumb()} />}>
      <section class="plugin-catalog-detail plugin-catalog-detail--rail skill-page">
        {breadcrumb()}
        <div class="skill-page__absent">
          {props.message ?? (
            <p class="muted" role="status">
              {t("skillsPage.notFound")}
            </p>
          )}
        </div>
      </section>
    </Show>
  );
}
