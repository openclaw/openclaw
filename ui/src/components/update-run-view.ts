import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { UPDATE_RUN_PHASES } from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import {
  isAcknowledgedAbandonedUpdateRun,
  type UpdateRunRecord,
  type UpdateRunStep,
} from "../../../src/infra/update-run-record.ts";
import { renderUpdateRunReport } from "../../../src/infra/update-run-report.ts";
import { isReportableUpdateRun } from "../../../src/shared/update-outcome.ts";
import { projectUpdateRun, updateRunStepOwner } from "../app/update-run-projection.ts";
import { t } from "../i18n/index.ts";
import { registerUpdateActionsEnglish } from "../i18n/locales/en-update-actions.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { clampText } from "../lib/format.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { StreamAutoFollowController } from "../lit/stream-auto-follow-controller.ts";
import { copyMarkdownText } from "./markdown-copy.ts";
import "../styles/update-run-view.css";

registerUpdateActionsEnglish();

const STEP_LABELS: Record<string, string> = {
  "snapshot-space-preflight": "snapshotSpace",
  "updater-runtime-retention": "prepareUpdater",
  "candidate-snapshot": "snapshot",
  "git fetch": "fetch",
  "git fetch tags": "fetch",
  "git fetch target tag": "fetch",
  "global update": "update",
  "global update (omit optional)": "update",
  install: "install",
  build: "build",
  "ui:build": "buildUi",
  doctor: "doctor",
};

function formatUpdateRunStepLabel(step: string): string {
  const owner = updateRunStepOwner(step);
  if (UPDATE_RUN_PHASES.some((phase) => phase === owner)) {
    return t(`updates.run.phase.${owner}`);
  }
  const key = STEP_LABELS[owner];
  const label = key
    ? t(`updates.run.stepLabel.${key}`)
    : owner.replace(/[-_:]+/gu, " ").replace(/^./u, (letter) => letter.toUpperCase());
  return step.startsWith("warning:") ? t("updates.run.stepWarning", { step: label }) : label;
}

function repairPrompt(run: UpdateRunRecord): string {
  // The report truncates some diagnostics, so redact complete source fields first.
  const safeRun = JSON.parse(
    JSON.stringify(run, (_key, value) =>
      typeof value === "string" ? redactRepairFact(value) : value,
    ),
    // SAFETY: the update record is JSON data; the replacer changes only string values.
  ) as UpdateRunRecord;
  const report = renderUpdateRunReport(safeRun);
  const facts = clampText(
    redactRepairFact(
      [
        `Run ID: ${safeRun.runId}`,
        `Installed: ${formatUpdateIdentity([
          ["version", safeRun.before.version],
          ["SHA", safeRun.before.sha],
        ])}`,
        `Requested target: ${formatUpdateIdentity([
          ["version", safeRun.target.version],
          ["SHA", safeRun.target.sha],
          ["tag", safeRun.target.tag],
        ])}`,
        report.markdown,
      ].join("\n"),
    ),
    1_800,
  );
  return t("updates.run.repairPrompt", { facts });
}

function formatUpdateIdentity(fields: Array<[string, string | null | undefined]>): string {
  return (
    fields
      .flatMap(([label, value]) => (value ? [`${label}: ${clampText(value, 120)}`] : []))
      .join("; ") || "unknown"
  );
}

function redactRepairFact(value: string): string {
  return redactToolDetail(value).replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/gu,
    "[redacted private key]",
  );
}

const STEP_MARKS = {
  completed: "✓",
  in_progress: "◌",
  pending: "○",
  failed: "×",
  skipped: "−",
} as const;
const ORACLE_MARKS = { pass: "✓", warn: "!", fail: "×", pending: "○" } as const;

function renderReportHeadline(headline: string) {
  // Terminal reports lead with a status symbol; give it a visible gap even when
  // the emoji font paints beyond the ordinary space's advance width.
  const separator = headline.indexOf(" ");
  return html`<span class="update-run-view__headline-mark">${headline.slice(0, separator)}</span
    >${headline.slice(separator)}`;
}

class UpdateRunView extends OpenClawLightDomElement {
  @property({ attribute: false }) run: UpdateRunRecord | null = null;
  @property({ type: Boolean }) connected = true;
  @state() private copyStatus: "idle" | "copied" | "failed" = "idle";

  private readonly streamFollow = new StreamAutoFollowController(this, {
    selector: ".update-run-view__details",
    isEnabled: () => true,
    captureCurrent: () => {
      const runId = this.run?.runId;
      return () => this.isConnected && this.run?.runId === runId;
    },
  });

  private readonly stepsFollow = new StreamAutoFollowController(this, {
    selector: ".update-run-view__step-scroll",
    isEnabled: () =>
      Boolean(this.querySelector<HTMLDetailsElement>(".update-run-view__step-list")?.open),
    captureCurrent: () => {
      const runId = this.run?.runId;
      return () => this.isConnected && this.run?.runId === runId;
    },
  });

  override updated(changed: PropertyValues<this>) {
    super.updated(changed);
    if (changed.has("run")) {
      const previous = changed.get("run");
      if (previous?.runId !== this.run?.runId || previous?.updatedAtMs !== this.run?.updatedAtMs) {
        this.copyStatus = "idle";
      }
      this.streamFollow.schedule(previous?.runId !== this.run?.runId);
      this.stepsFollow.schedule(previous?.runId !== this.run?.runId);
    }
  }

  private copyRepairPrompt(event: Event) {
    const run = this.run;
    const button = event.currentTarget;
    if (!run || !(button instanceof HTMLButtonElement)) {
      return;
    }
    copyMarkdownText(
      button,
      repairPrompt(run),
      () =>
        this.isConnected &&
        this.run?.runId === run.runId &&
        this.run?.updatedAtMs === run.updatedAtMs,
      (copied) => {
        this.copyStatus = copied === undefined ? "idle" : copied ? "copied" : "failed";
      },
    );
  }

  private renderStep(step: UpdateRunStep, label = formatUpdateRunStepLabel(step.step)) {
    const details = step.detail;
    const status = t(`updates.run.step.${step.status}`);
    return html`<li
      class="update-run-view__step update-run-view__step--${step.status}"
      data-step=${step.step}
      data-status=${step.status}
      title=${step.step}
      aria-label=${`${label}: ${status}`}
    >
      <span class="update-run-view__mark" aria-hidden="true">${STEP_MARKS[step.status]}</span>
      ${
        details
          ? html`<details class="update-run-view__step-detail">
              <summary>${label}</summary>
              <pre class="update-run-view__step-output" tabindex="0" aria-label=${label}>
${details}</pre>
            </details>`
          : html`<span>${label}</span>`
      }
      <span class="update-run-view__step-status">${status}</span>
    </li>`;
  }

  override render() {
    if (!this.run) {
      return nothing;
    }
    const view = projectUpdateRun(this.run, this.connected);
    const headline = view.terminal ? renderReportHeadline(view.headline) : view.headline;
    return html`<section
      class="update-run-view"
      data-run-id=${this.run.runId}
      data-run-status=${this.run.status}
      aria-label=${t("updates.run.title")}
    >
      <header class="update-run-view__heading">
        <h3 role="status" aria-live="polite">${headline}</h3>
        ${view.compactLabel ? html`<span class="update-run-view__progress">${view.compactLabel}</span>` : nothing}
      </header>
      ${!this.connected && !view.terminal ? html`<p class="update-run-view__connection">${t("updates.run.reconnecting")}</p>` : nothing}
      ${
        view.phases.length
          ? html`<ol class="update-run-view__phases" aria-label=${t("updates.run.phases")}>
              ${view.phases.map((phase) => this.renderStep(phase, phase.label))}
            </ol>`
          : nothing
      }
      ${
        view.steps.length
          ? html`<details
              class="update-run-view__step-list"
              @toggle=${(event: Event) => {
                if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open) {
                  this.stepsFollow.schedule(true);
                }
              }}
            >
              <summary>${t("updates.run.steps")}</summary>
              <ol
                class="update-run-view__step-scroll"
                tabindex="0"
                aria-label=${t("updates.run.steps")}
                @scroll=${(event: Event) => this.stepsFollow.handleScroll(event)}
              >
                ${view.steps.map((step) => this.renderStep(step))}
              </ol>
            </details>`
          : nothing
      }
      <details
        class="update-run-view__diagnostics"
        open
        @toggle=${(event: Event) => {
          if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open) {
            this.streamFollow.schedule(true);
          }
        }}
      >
        <summary>
          ${t("updates.run.details")}
          ${view.detailStep ? html`<span title=${view.detailStep}>${formatUpdateRunStepLabel(view.detailStep)}</span>` : nothing}
        </summary>
        <pre
          class="update-run-view__details"
          tabindex="0"
          aria-label=${t("updates.run.details")}
          @scroll=${(event: Event) => this.streamFollow.handleScroll(event)}
        >
${view.details || t(view.detailStep === "updater-runtime-retention" ? "updates.run.prepareUpdaterDetails" : "updates.run.noDetails")}</pre>
      </details>
      ${
        view.oracles.length
          ? html`<ul class="update-run-view__oracles" aria-label=${t("updates.run.verification")}>
              ${view.oracles.map((oracle) => html`<li data-oracle=${oracle.name} data-state=${oracle.state} class="update-run-view__oracle update-run-view__oracle--${oracle.state}"><span aria-hidden="true">${ORACLE_MARKS[oracle.state]}</span><span>${t(`updates.run.oracle.${oracle.name}`)}</span><small>${t(`updates.run.oracleState.${oracle.state}`)}</small></li>`)}
            </ul>`
          : nothing
      }
      ${
        view.terminal
          ? html`<section
              class="update-run-view__report ${view.reconciled ? "" : `update-run-view__report--${this.run.status}`}"
              aria-label=${t("updates.run.report")}
            >
              <h4>${renderReportHeadline(view.report.headline)}</h4>
              <div class="update-run-view__report-body" tabindex="0">
                ${view.report.lines.map((line) => html`<p>${line}</p>`)}
              </div>
              ${
                isReportableUpdateRun(this.run) &&
                !isAcknowledgedAbandonedUpdateRun(this.run) &&
                this.run.target.installationMethod !== "ocm"
                  ? html`<div class="update-run-view__prompt-action">
                      <button
                        class="btn btn--sm update-run-view__copy-prompt"
                        type="button"
                        @click=${(event: Event) => this.copyRepairPrompt(event)}
                      >
                        ${t("updates.run.copyAgentPrompt")}
                      </button>
                      <span role="status" aria-live="polite">
                        ${
                          this.copyStatus === "copied"
                            ? t("updates.run.promptCopied")
                            : this.copyStatus === "failed"
                              ? t("updates.run.promptCopyFailed")
                              : nothing
                        }
                      </span>
                    </div>`
                  : nothing
              }
            </section>`
          : nothing
      }
    </section>`;
  }
}

if (!customElements.get("openclaw-update-run-view")) {
  customElements.define("openclaw-update-run-view", UpdateRunView);
}
