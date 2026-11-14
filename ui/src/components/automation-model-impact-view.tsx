import { createMemo, For } from "solid-js";
import type { CronModelImpactResult } from "../../../packages/gateway-protocol/src/schema/cron-model-impact.ts";
import { t } from "../lib/reactive/i18n.ts";

export function AutomationModelImpactDialog(props: {
  impact: CronModelImpactResult;
  canConfirm: () => boolean;
  finish: (confirmed: boolean) => void;
}) {
  let cancelButton!: HTMLButtonElement;
  const enabled = createMemo(() =>
    props.impact.jobs
      .filter((job) => job.enabled)
      .toSorted(
        (left, right) =>
          Number(right.status === "blocked" || right.status === "unknown") -
          Number(left.status === "blocked" || left.status === "unknown"),
      ),
  );
  return (
    <openclaw-modal-dialog
      label={t("modelProviders.automationModelImpact.title")}
      prop:initialFocus={() => cancelButton}
      onModal-cancel={() => props.finish(false)}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-title">{t("modelProviders.automationModelImpact.title")}</div>
        <p class="exec-approval-sub">{t("modelProviders.automationModelImpact.warning")}</p>
        <div class="exec-approval-command" style={{ "font-family": "inherit" }}>
          <p>
            <strong>
              {t("modelProviders.automationModelImpact.enabled", {
                count: String(enabled().length),
              })}
            </strong>
          </p>
          <p>
            {t("modelProviders.automationModelImpact.changed", {
              count: String(enabled().filter((job) => job.changed).length),
            })}
          </p>
          <For each={enabled()} keyed={(job) => job.id}>
            {(job) => (
              <div class="callout">
                <strong>{job().name}</strong>
                <div>
                  {t("modelProviders.automationModelImpact.transition", {
                    before:
                      job().before.model ?? t("modelProviders.automationModelImpact.unresolved"),
                    after:
                      job().after.model ?? t("modelProviders.automationModelImpact.unresolved"),
                  })}
                </div>
                <div>
                  {!job().changed
                    ? t("modelProviders.automationModelImpact.unchanged") + " · "
                    : ""}
                  {t("modelProviders.automationModelImpact.status." + job().status)}
                </div>
                <For each={job().issues}>
                  {(issue) => (
                    <p>
                      {issue.message} {issue.recovery}
                    </p>
                  )}
                </For>
              </div>
            )}
          </For>
          <For each={props.impact.issues}>
            {(issue) => (
              <p>
                {issue.message} {issue.recovery}
              </p>
            )}
          </For>
        </div>
        <p class="exec-approval-sub">
          {t("modelProviders.automationModelImpact.disabled", {
            count: String(props.impact.jobs.length - enabled().length),
          })}
        </p>
        <p class="exec-approval-sub">{t("modelProviders.automationModelImpact.recovery")}</p>
        <openclaw-modal-actions class="exec-approval-actions">
          <button
            ref={(element) => {
              cancelButton = element;
            }}
            class="btn"
            onClick={() => props.finish(false)}
          >
            {t("modelProviders.automationModelImpact.cancel")}
          </button>
          <button
            class="btn primary"
            disabled={!props.canConfirm()}
            onClick={() => {
              if (props.canConfirm()) {
                props.finish(true);
              }
            }}
          >
            {t("modelProviders.automationModelImpact.confirm")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}
