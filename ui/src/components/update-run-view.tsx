import { For, Show, createEffect, createMemo } from "solid-js";
import { UPDATE_RUN_PHASES } from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import type { UpdateRunRecord, UpdateRunStep } from "../../../src/infra/update-run-record.ts";
import { projectUpdateRun, updateRunStepOwner } from "../app/update-run-projection.ts";
import { registerUpdateActionsEnglish } from "../i18n/locales/en-update-actions.ts";
import { i18nRevision, registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { useStreamAutoFollow } from "../lib/reactive/stream-auto-follow.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import "../styles/update-run-view.css";

registerEnglishCatalog(registerUpdateActionsEnglish);

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

const STEP_MARKS = {
  completed: "✓",
  in_progress: "◌",
  pending: "○",
  failed: "×",
  skipped: "−",
} as const;
const ORACLE_MARKS = { pass: "✓", warn: "!", fail: "×", pending: "○" } as const;

function ReportHeadline(props: { headline: string }) {
  // Keep the terminal status symbol clear of the text in emoji fonts.
  const separator = () => props.headline.indexOf(" ");
  return (
    <>
      <span class="update-run-view__headline-mark">{props.headline.slice(0, separator())}</span>
      {props.headline.slice(separator())}
    </>
  );
}

function RunStep(props: { step: UpdateRunStep; label?: string }) {
  const label = () => props.label ?? formatUpdateRunStepLabel(props.step.step);
  const status = () => t(`updates.run.step.${props.step.status}`);
  return (
    <li
      class={`update-run-view__step update-run-view__step--${props.step.status}`}
      data-step={props.step.step}
      data-status={props.step.status}
      title={props.step.step}
      aria-label={`${label()}: ${status()}`}
    >
      <span class="update-run-view__mark" aria-hidden="true">
        {STEP_MARKS[props.step.status]}
      </span>
      <Show when={props.step.detail} fallback={<span>{label()}</span>}>
        <details class="update-run-view__step-detail">
          <summary>{label()}</summary>
          <pre class="update-run-view__step-output" tabindex={0} aria-label={label()}>
            {props.step.detail}
          </pre>
        </details>
      </Show>
      <span class="update-run-view__step-status">{status()}</span>
    </li>
  );
}

function UpdateRunContent(props: { run: UpdateRunRecord | null; connected: boolean }) {
  let details: HTMLPreElement | undefined;
  let steps: HTMLOListElement | undefined;
  const identity = () => props.run?.runId;
  const logFollow = useStreamAutoFollow({
    container: () => details,
    identity,
    enabled: () => true,
  });
  const stepsFollow = useStreamAutoFollow({
    container: () => steps,
    identity,
    enabled: () => Boolean(steps?.parentElement?.hasAttribute("open")),
  });
  createEffect(
    () => props.run,
    (run, previous) => {
      const changedRun = run?.runId !== previous?.runId;
      logFollow.schedule(changedRun);
      stepsFollow.schedule(changedRun);
    },
  );
  const view = createMemo(() => {
    i18nRevision();
    return props.run ? projectUpdateRun(props.run, props.connected) : null;
  });
  return (
    <Show when={view()}>
      {(current) => (
        <section
          class="update-run-view"
          data-run-id={props.run?.runId}
          data-run-status={props.run?.status}
          aria-label={t("updates.run.title")}
        >
          <header class="update-run-view__heading">
            <h3 role="status" aria-live="polite">
              <Show when={current().terminal} fallback={current().headline}>
                <ReportHeadline headline={current().headline} />
              </Show>
            </h3>
            <Show when={current().compactLabel}>
              <span class="update-run-view__progress">{current().compactLabel}</span>
            </Show>
          </header>
          <Show when={!props.connected && !current().terminal}>
            <p class="update-run-view__connection">{t("updates.run.reconnecting")}</p>
          </Show>
          <Show when={current().phases.length}>
            <ol class="update-run-view__phases" aria-label={t("updates.run.phases")}>
              <For each={current().phases} keyed={false}>
                {(phase) => <RunStep step={phase()} label={phase().label} />}
              </For>
            </ol>
          </Show>
          <Show when={current().steps.length}>
            <details
              class="update-run-view__step-list"
              onToggle={(event) => event.currentTarget.open && stepsFollow.schedule(true)}
            >
              <summary>{t("updates.run.steps")}</summary>
              <ol
                ref={(element) => {
                  steps = element;
                }}
                class="update-run-view__step-scroll"
                tabindex={0}
                aria-label={t("updates.run.steps")}
                onScroll={stepsFollow.handleScroll}
              >
                <For each={current().steps} keyed={false}>
                  {(step) => <RunStep step={step()} />}
                </For>
              </ol>
            </details>
          </Show>
          <details
            class="update-run-view__diagnostics"
            open
            onToggle={(event) => event.currentTarget.open && logFollow.schedule(true)}
          >
            <summary>
              {t("updates.run.details")}{" "}
              <Show when={current().detailStep}>
                {(step) => <span title={step()}>{formatUpdateRunStepLabel(step())}</span>}
              </Show>
            </summary>
            <pre
              ref={(element) => {
                details = element;
              }}
              class="update-run-view__details"
              tabindex={0}
              aria-label={t("updates.run.details")}
              onScroll={logFollow.handleScroll}
            >
              {current().details ||
                t(
                  current().detailStep === "updater-runtime-retention"
                    ? "updates.run.prepareUpdaterDetails"
                    : "updates.run.noDetails",
                )}
            </pre>
          </details>
          <Show when={current().oracles.length}>
            <ul class="update-run-view__oracles" aria-label={t("updates.run.verification")}>
              <For each={current().oracles}>
                {(oracle) => (
                  <li
                    data-oracle={oracle.name}
                    data-state={oracle.state}
                    class={`update-run-view__oracle update-run-view__oracle--${oracle.state}`}
                  >
                    <span aria-hidden="true">{ORACLE_MARKS[oracle.state]}</span>
                    <span>{t(`updates.run.oracle.${oracle.name}`)}</span>
                    <small>{t(`updates.run.oracleState.${oracle.state}`)}</small>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={current().terminal}>
            <section
              class={[
                "update-run-view__report",
                { [`update-run-view__report--${props.run?.status}`]: !current().reconciled },
              ]}
              aria-label={t("updates.run.report")}
            >
              <h4>
                <ReportHeadline headline={current().report.headline} />
              </h4>
              <div class="update-run-view__report-body" tabindex={0}>
                <For each={current().report.lines}>{(line) => <p>{line}</p>}</For>
              </div>
            </section>
          </Show>
        </section>
      )}
    </Show>
  );
}

defineSolidBridge<{ run: UpdateRunRecord | null; connected: boolean }>(
  "openclaw-update-run-view",
  UpdateRunContent,
  {
    properties: {
      run: { default: null, attribute: false },
      connected: { default: true },
    },
  },
);
