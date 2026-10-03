import { html, nothing } from "lit";
import type { SessionActivityPulse } from "../../../../src/shared/session-types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { activityPulseBucketStart } from "./activity-pulse-window.ts";
import { TIME_LABELS, type ActivityTimeFilter } from "./session-activity.ts";

registerActivityEnglish();

export function renderSessionActivityPulse(
  pulse: SessionActivityPulse,
  time: ActivityTimeFilter,
  options: { peopleIncomplete?: boolean },
) {
  const formats: Record<ActivityTimeFilter, Intl.DateTimeFormatOptions> = {
    "24h": { hour: "numeric" },
    "7d": { month: "short", day: "numeric" },
    "30d": { month: "short", day: "numeric" },
    all: { month: "short" },
  };
  const period = new Intl.DateTimeFormat(undefined, formats[time]);
  const label = (index: number) =>
    period.format(activityPulseBucketStart(time, pulse.since, index));
  const windowLabel = t(TIME_LABELS[time]);
  const peak = Math.max(...pulse.buckets);
  // Few wide buckets (7 days, months) leave room for only three labels.
  const labels = pulse.buckets.length > 12 ? 4 : 2;
  const axis = new Set(
    Array.from({ length: labels + 1 }, (_, index) =>
      Math.round((index * (pulse.buckets.length - 1)) / labels),
    ),
  );
  const stats = [
    ["sessions", pulse.sessions],
    ["started", pulse.started],
    ["people", pulse.people],
    ["running", pulse.running],
  ] as const;
  return html`<section class="activity-pulse">
    <div class="activity-pulse__header">
      <div class="activity-pulse__heading">${icons.activity}<strong>${windowLabel}</strong></div>
      <div class="activity-pulse__stats">
        ${stats
          .filter(([, value]) => value !== undefined)
          .map(
            ([key, value], index) => html`
              ${index ? " · " : nothing}<span
                title=${key === "people" && options.peopleIncomplete ? t("activityFeed.partialHistory") : nothing}
                >${key === "running" && pulse.running > 0 ? html`<i class="activity-pulse__running" aria-hidden="true"></i>` : nothing}<b
                  >${key === "people" && options.peopleIncomplete ? `${value}+` : value}</b
                >
                ${t(`activity.pulse.${key}`)}</span
              >
            `,
          )}
      </div>
    </div>
    <div
      class="activity-pulse__bars"
      role="img"
      aria-label=${t("activity.pulse.description", { window: windowLabel, count: String(pulse.sessions), period: label(pulse.buckets.indexOf(peak)) })}
    >
      ${pulse.buckets.map(
        (count, index) => html`<span
          class="activity-pulse__bar"
          data-bucket=${index === pulse.buckets.length - 1 ? "current" : "past"}
          style=${`height: max(2px, ${peak > 0 ? (count / peak) * 100 : 0}%)`}
          title=${t("activity.pulse.bucket", { period: label(index), count: String(count) })}
        ></span>`,
      )}
    </div>
    <div class="activity-pulse__axis" aria-hidden="true">
      ${pulse.buckets.map(
        (_, index) =>
          html`<span>${axis.has(index) ? html`<span>${label(index)}</span>` : nothing}</span>`,
      )}
    </div>
  </section>`;
}
