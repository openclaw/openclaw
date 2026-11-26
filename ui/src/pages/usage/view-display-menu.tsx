import { For, createMemo } from "solid-js";
import { iconButtonClass } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import {
  Menu,
  createMenuControls,
  type MenuEntry,
  type MenuItem,
} from "../../components/solid/menu.tsx";
import { SwitchIndicator } from "../../components/solid/switch.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { UsageProps } from "./types.ts";

type Choice = { value: string; label: string; title?: string };

/** View settings in one Display menu: metric, chart breakdown, time zone, session scope and pin. */
export function UsageDisplayMenu(props: { usage: UsageProps; phone: boolean }) {
  const controls = createMenuControls();
  const usage = () => props.usage;
  const metrics = [
    { value: "tokens", label: () => t("usage.metrics.tokens"), icon: "hash" },
    { value: "cost", label: () => t("usage.metrics.cost"), icon: "coins" },
  ] as const;
  const metricEntry: MenuEntry = {
    kind: "content",
    id: "metric",
    content: (
      <div class="usage-display-menu__metric" role="group" aria-label={t("usage.display.metric")}>
        <For each={metrics}>
          {(metric) => (
            <button
              ref={controls.ref()}
              type="button"
              data-form-control=""
              aria-pressed={usage().display.chartMode === metric.value ? "true" : "false"}
              onClick={() => usage().callbacks.display.onChange({ chartMode: metric.value })}
            >
              <Icon name={metric.icon} />
              {metric.label()}
            </button>
          )}
        </For>
      </div>
    ),
  };
  const choiceMenu = (
    id: string,
    label: string,
    value: string,
    choices: readonly Choice[],
  ): MenuItem => ({
    id,
    label,
    class: "usage-display-menu__setting",
    details: (
      <span class="usage-display-menu__value">
        {choices.find((choice) => choice.value === value)?.label}
      </span>
    ),
    children: choices.map((choice) => ({
      id: `${id}:${choice.value}`,
      label: choice.label,
      type: "radio" as const,
      checked: choice.value === value,
      attributes: choice.title ? { title: choice.title } : undefined,
    })),
  });
  const separator = (id: string): MenuEntry => ({
    kind: "content",
    id,
    content: <div role="separator" />,
  });
  const items = createMemo((): MenuEntry[] => [
    metricEntry,
    separator("metric-end"),
    choiceMenu("breakdown", t("usage.display.breakdown"), usage().display.dailyChartMode, [
      { value: "total", label: t("usage.daily.total") },
      { value: "by-type", label: t("usage.daily.byType") },
      { value: "by-provider", label: t("usage.daily.byProvider") },
    ]),
    choiceMenu("timeZone", t("usage.filters.timeZone"), usage().filters.timeZone, [
      { value: "local", label: t("usage.filters.timeZoneLocal") },
      { value: "utc", label: t("usage.filters.timeZoneUtc") },
    ]),
    choiceMenu("scope", t("usage.display.sessions"), usage().filters.scope, [
      {
        value: "instance",
        label: t("usage.scope.instance"),
        title: t("usage.scope.instanceHint"),
      },
      { value: "family", label: t("usage.scope.family"), title: t("usage.scope.familyHint") },
    ]),
    // A sticky header would take too much of a phone's viewport.
    ...(props.phone
      ? []
      : [
          separator("pin-start"),
          {
            id: "pin",
            label: t("usage.display.pin"),
            type: "checkbox" as const,
            checked: usage().display.headerPinned,
            closeOnSelect: false,
            class: "oc-menu-item--switch usage-display-menu__setting",
            details: <SwitchIndicator checked={usage().display.headerPinned} size="sm" />,
          },
        ]),
  ]);
  const select = (item: MenuItem) => {
    const [key, value] = item.id.split(":");
    if (key === "pin") {
      usage().callbacks.filters.onToggleHeaderPinned();
    } else if (
      key === "breakdown" &&
      (value === "total" || value === "by-type" || value === "by-provider")
    ) {
      usage().callbacks.display.onChange({ dailyChartMode: value });
    } else if (key === "timeZone" && (value === "local" || value === "utc")) {
      usage().callbacks.filters.onScopeChange({ timeZone: value });
    } else if (key === "scope" && (value === "instance" || value === "family")) {
      usage().callbacks.filters.onScopeChange({ scope: value });
    }
  };
  return (
    <Menu
      id="usage-display-menu"
      lazy
      label={t("usage.display.title")}
      class="usage-display-menu"
      panelClass="usage-display-menu__panel"
      triggerClass={[
        props.phone ? "btn btn--sm usage-filter-sheet__trigger" : iconButtonClass(),
        "usage-display-menu__trigger",
      ]}
      triggerAttributes={{ title: t("usage.display.title") }}
      placement="bottom-end"
      controls={controls}
      items={items()}
      onSelect={select}
      trigger={<Icon name="slidersHorizontal" />}
    />
  );
}
