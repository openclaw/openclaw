import { html, nothing } from "lit";
import type { SessionActivityPulse } from "../../../../src/shared/session-types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";

registerActivityEnglish();

export function renderSessionActivityPulse(
  pulse: SessionActivityPulse,
  now: number,
  options: { peopleIncomplete?: boolean },
) {
  const hour = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
  const label = (index: number) => hour.format(pulse.since + index * 3_600_000);
  const current = Math.max(
    0,
    Math.min(pulse.hours.length - 1, Math.floor((now - pulse.since) / 3_600_000)),
  );
  const shown = pulse.hours.slice(0, current + 1);
  const peak = Math.max(...shown);
  const stats = [
    ["sessions", pulse.sessions],
    ["started", pulse.started],
    ["people", pulse.people],
    ["running", pulse.running],
  ] as const;
  return html`<section class="activity-pulse">
    <div class="activity-pulse__header">
      <div class="activity-pulse__heading">
        ${icons.activity}<strong>${t("activityFeed.today")}</strong>
        <span
          >${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now)}</span
        >
      </div>
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
      aria-label=${t("activity.pulse.description", { count: String(pulse.sessions), hour: label(shown.indexOf(peak)) })}
    >
      ${pulse.hours.map(
        (count, index) => html`<span
          class="activity-pulse__bar"
          data-hour=${index === current ? "current" : index < current ? "past" : "future"}
          style=${`height: max(2px, ${index <= current && peak > 0 ? (count / peak) * 100 : 0}%)`}
          title=${t("activity.pulse.hour", { hour: label(index), count: String(count) })}
        ></span>`,
      )}
    </div>
    <div class="activity-pulse__axis" aria-hidden="true">
      ${[0, 6, 12, 18].map((index) => html`<span>${label(index)}</span>`)}
      <span>${hour.format(pulse.until)}</span>
    </div>
  </section>`;
}
