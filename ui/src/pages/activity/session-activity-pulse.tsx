import { createMemo } from "@solidjs/signals";
import { For, Show } from "solid-js";
import type { SessionActivityPulse } from "../../../../src/shared/session-types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { activityPulseBucketStart } from "./activity-pulse-window.ts";
import { TIME_LABELS, type ActivityTimeFilter } from "./session-activity.ts";

registerEnglishCatalog(registerActivityEnglish);

type SessionActivityPulseProps = {
  pulse: SessionActivityPulse;
  time: ActivityTimeFilter;
  options: { peopleIncomplete?: boolean };
};

export function renderSessionActivityPulse(props: SessionActivityPulseProps) {
  const chart = createMemo(() => {
    const formats: Record<ActivityTimeFilter, Intl.DateTimeFormatOptions> = {
      "24h": { hour: "numeric" },
      "7d": { month: "short", day: "numeric" },
      "30d": { month: "short", day: "numeric" },
      all: { month: "short" },
    };
    const time = props.time;
    const pulse = props.pulse;
    const period = new Intl.DateTimeFormat(undefined, formats[time]);
    // Few wide buckets (7 days, months) leave room for only three labels.
    const labels = pulse.buckets.length > 12 ? 4 : 2;
    return {
      label: (index: number) => period.format(activityPulseBucketStart(time, pulse.since, index)),
      windowLabel: t(TIME_LABELS[time]),
      peak: Math.max(...pulse.buckets),
      axis: new Set(
        Array.from({ length: labels + 1 }, (_, index) =>
          Math.round((index * (pulse.buckets.length - 1)) / labels),
        ),
      ),
    };
  });
  return (
    <section class="activity-pulse">
      <div class="activity-pulse__header">
        <div class="activity-pulse__heading">
          <Icon name="activity" />
          <strong>{chart().windowLabel}</strong>
        </div>
        <div class="activity-pulse__stats">
          <For each={["sessions", "started", "people", "running"] as const}>
            {(key, index) => (
              <Show when={props.pulse[key] !== undefined}>
                {index() ? " · " : undefined}
                <span
                  title={
                    key === "people" && props.options.peopleIncomplete
                      ? t("activityFeed.partialHistory")
                      : undefined
                  }
                >
                  {key === "running" && props.pulse.running > 0 ? (
                    <i class="activity-pulse__running" aria-hidden="true" />
                  ) : undefined}
                  <b>
                    {key === "people" && props.options.peopleIncomplete
                      ? `${props.pulse[key]}+`
                      : props.pulse[key]}
                  </b>{" "}
                  {t(`activity.pulse.${key}`)}
                </span>
              </Show>
            )}
          </For>
        </div>
      </div>
      <div
        class="activity-pulse__bars"
        role="img"
        aria-label={t("activity.pulse.description", {
          window: chart().windowLabel,
          count: String(props.pulse.sessions),
          period: chart().label(props.pulse.buckets.indexOf(chart().peak)),
        })}
      >
        <For each={props.pulse.buckets} keyed={false}>
          {(count, index) => (
            <span
              class="activity-pulse__bar"
              data-bucket={index === props.pulse.buckets.length - 1 ? "current" : "past"}
              style={{
                height: `max(2px, ${chart().peak > 0 ? (count() / chart().peak) * 100 : 0}%)`,
              }}
              title={t("activity.pulse.bucket", {
                period: chart().label(index),
                count: String(count()),
              })}
            />
          )}
        </For>
      </div>
      <div class="activity-pulse__axis" aria-hidden="true">
        <For each={props.pulse.buckets} keyed={false}>
          {(_, index) => (
            <span>{chart().axis.has(index) ? <span>{chart().label(index)}</span> : undefined}</span>
          )}
        </For>
      </div>
    </section>
  );
}
