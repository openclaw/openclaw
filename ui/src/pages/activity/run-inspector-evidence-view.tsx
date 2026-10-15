import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import type {
  AuditRunInspectResult,
  DecisionReceiptDisplayV1,
} from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { t } from "../../lib/reactive/i18n.ts";
import {
  activityRunInspectorSelectorHref,
  type RunInspectorSelector,
  type RunInspectorState,
} from "./run-inspector-model.ts";

type ReceiptSectionOptions = { headingId?: string; headingLevel?: 3 | 6 };

export function runInspectorCoverageKey(
  state: AuditRunInspectResult["coverage"]["state"],
): "enforced" | "attributionOnly" | "unattributed" | "unknown" | "unsupported" {
  return state === "attribution-only" ? "attributionOnly" : state;
}

export function runInspectorCoverageLabel(
  state: AuditRunInspectResult["coverage"]["state"],
): string {
  return t(`activity.runInspector.coverage.${runInspectorCoverageKey(state)}.label`);
}

export function renderRunInspectorSafeRef(value: string | number, mono = false, href?: string) {
  const content = (
    <bdi class={mono ? "run-inspector__ref mono" : "run-inspector__ref"} dir="ltr">
      {value}
    </bdi>
  );
  return href ? <a href={href}>{content}</a> : content;
}

export function renderRunInspectorValues(
  section: "values" | "decisions",
  values: readonly (readonly [string, string | number | JSX.Element])[],
) {
  return (
    <dl class="run-inspector__values">
      <For each={values} keyed={false}>
        {(item) => (
          <div>
            <dt>{t(`activity.runInspector.${section}.${item()[0]}`)}</dt>
            <dd>{item()[1]}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

function renderSectionHeading(label: string, headingId: string, headingLevel: 3 | 6) {
  return headingLevel === 6 ? <h6 id={headingId}>{label}</h6> : <h3 id={headingId}>{label}</h3>;
}

export function renderRunInspectorMissingEvidence(
  values: readonly string[],
  options: ReceiptSectionOptions = {},
) {
  const headingId = options.headingId ?? "run-inspector-missing-heading";
  return (
    <section class="run-inspector__section" aria-labelledby={headingId}>
      {renderSectionHeading(
        t("activity.runInspector.missingEvidenceHeading"),
        headingId,
        options.headingLevel ?? 3,
      )}
      {values.length === 0 ? (
        <p>{t("activity.runInspector.noMissingEvidence")}</p>
      ) : (
        <ul class="run-inspector__code-list">
          <For each={values} keyed={false}>
            {(value) => <li>{renderRunInspectorSafeRef(value(), true)}</li>}
          </For>
        </ul>
      )}
    </section>
  );
}

export function renderRunInspectorRemediation(
  remediation: readonly { code: string; text: string }[],
  options: ReceiptSectionOptions = {},
): JSX.Element | undefined {
  if (remediation.length === 0) {
    return undefined;
  }
  const headingId = options.headingId ?? "run-inspector-remediation-heading";
  return (
    <section class="run-inspector__section" aria-labelledby={headingId}>
      {renderSectionHeading(
        t("activity.runInspector.nextStepsHeading"),
        headingId,
        options.headingLevel ?? 3,
      )}
      <ul class="run-inspector__remediation-list">
        <For each={remediation} keyed={(item) => item.code}>
          {(item) => (
            <li>
              <span>{item().text}</span> {renderRunInspectorSafeRef(item().code, true)}
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

function decisionOutcomeLabel(outcome: DecisionReceiptDisplayV1["decision"]["outcome"]): string {
  return t(
    `activity.runInspector.decisions.outcomes.${outcome === "not-applicable" ? "notApplicable" : outcome}`,
  );
}

function renderReceiptBadges(receipt: DecisionReceiptDisplayV1, accessible = false) {
  return (
    <For
      each={[
        [receipt.decision.outcome, decisionOutcomeLabel(receipt.decision.outcome), "outcomeLabel"],
        [
          receipt.enforcement.coverageState,
          runInspectorCoverageLabel(receipt.enforcement.coverageState),
          "classificationLabel",
        ],
      ]}
    >
      {([value, label, labelKey]) => (
        <span
          class={`run-inspector__receipt-badge run-inspector__receipt-badge--${value}`}
          role={accessible ? "img" : undefined}
          aria-label={
            accessible ? `${t(`activity.runInspector.decisions.${labelKey}`)}: ${label}` : undefined
          }
        >
          {label}
        </span>
      )}
    </For>
  );
}

export function renderRunInspectorPagination(
  kind: "candidates" | "decisions",
  status: "loading" | "error" | undefined,
  onLoad: () => void,
) {
  return (
    <div class="run-inspector__pagination">
      <span>{t(`activity.runInspector.${kind}.more`)}</span>
      <button type="button" class="btn" disabled={status === "loading"} onClick={onLoad}>
        {t(`activity.runInspector.${kind}.${status === "loading" ? "loadingMore" : "loadMore"}`)}
      </button>
      {status === "error" ? (
        <span role="alert">{t(`activity.runInspector.${kind}.loadMoreError`)}</span>
      ) : undefined}
    </div>
  );
}

function renderReceiptDetail(receipt: DecisionReceiptDisplayV1) {
  const coverage = receipt.enforcement.coverageState;
  return (
    <article
      class="run-inspector__receipt-detail"
      data-receipt-selector-id={receipt.selectorId}
      aria-labelledby="run-inspector-receipt-detail"
    >
      <h4 id="run-inspector-receipt-detail">
        {t("activity.runInspector.decisions.detailHeading")}
      </h4>
      <section aria-labelledby="run-inspector-receipt-requested">
        <h5 id="run-inspector-receipt-requested">
          {t("activity.runInspector.decisions.requestedHeading")}
        </h5>
        {receipt.action.summary ? <p>{receipt.action.summary}</p> : undefined}
        {renderRunInspectorValues("values", [
          ["kind", renderRunInspectorSafeRef(receipt.action.family)],
          ["operation", renderRunInspectorSafeRef(receipt.action.operation)],
        ])}
      </section>
      <section aria-labelledby="run-inspector-receipt-outcome">
        <h5 id="run-inspector-receipt-outcome">
          {t("activity.runInspector.decisions.outcomeHeading")}
        </h5>
        <div class="run-inspector__receipt-badges">{renderReceiptBadges(receipt, true)}</div>
        <p class="run-inspector__reason">
          {t(`activity.runInspector.coverage.${runInspectorCoverageKey(coverage)}.description`)}
        </p>
        {renderRunInspectorValues("decisions", [
          ["reasonLabel", renderRunInspectorSafeRef(receipt.decision.reasonCode, true)],
          ["occurredAtLabel", new Date(receipt.occurredAt).toLocaleString()],
        ])}
      </section>
      <section aria-labelledby="run-inspector-receipt-owner">
        <h5 id="run-inspector-receipt-owner">
          {t("activity.runInspector.decisions.ownerHeading")}
        </h5>
        {receipt.provenance.state === "verified"
          ? renderRunInspectorValues("decisions", [
              ["durableOwnerLabel", renderRunInspectorSafeRef(receipt.provenance.producer)],
            ])
          : undefined}
        <p class="run-inspector__reason">{t("activity.runInspector.decisions.ownerNote")}</p>
      </section>
      <section aria-labelledby="run-inspector-receipt-evidence">
        <h5 id="run-inspector-receipt-evidence">
          {t("activity.runInspector.decisions.evidenceHeading")}
        </h5>
        {renderRunInspectorValues("decisions", [
          ["policyCountLabel", receipt.enforcement.policyCount],
          ["grantCountLabel", receipt.enforcement.grantCount],
        ])}
        <h6>{t("activity.runInspector.decisions.contextFieldsLabel")}</h6>
        {receipt.enforcement.contextFieldsUsed.length ? (
          <ul class="run-inspector__code-list">
            <For each={receipt.enforcement.contextFieldsUsed}>
              {(value) => <li>{renderRunInspectorSafeRef(value, true)}</li>}
            </For>
          </ul>
        ) : (
          <p class="run-inspector__reason">
            {t("activity.runInspector.decisions.noContextFields")}
          </p>
        )}
        {renderRunInspectorMissingEvidence(receipt.missingEvidence, {
          headingId: "run-inspector-receipt-missing-heading",
          headingLevel: 6,
        })}
      </section>
      {renderRunInspectorRemediation(receipt.remediation, {
        headingId: "run-inspector-receipt-remediation-heading",
        headingLevel: 6,
      })}
    </article>
  );
}

export function renderRunInspectorDecisions(
  state: Extract<RunInspectorState, { status: "ready" }>,
  selector: RunInspectorSelector | null,
  selectorId: string | null,
  basePath: string,
  onLoadMoreDecisions: () => void,
) {
  const result = state.result;
  const selectedReceipt = selectorId
    ? result.decisionDisplays.find((receipt) => receipt.selectorId === selectorId)
    : result.decisionDisplays[0];
  return (
    <section class="run-inspector__section" aria-labelledby="run-inspector-decisions-heading">
      <h3 id="run-inspector-decisions-heading">{t("activity.runInspector.decisions.heading")}</h3>
      {result.decisionDisplays.length === 0 ? (
        <p>{t("activity.runInspector.decisions.none")}</p>
      ) : (
        <p>
          {t("activity.runInspector.decisions.returned", {
            count: String(result.decisionDisplays.length),
          })}
        </p>
      )}
      <div class="run-inspector__warning" role="note">
        {t("activity.runInspector.decisions.readOnly")}
      </div>
      {result.decisionDisplays.length > 0 && selector ? (
        <ol
          class="run-inspector__receipt-list"
          aria-label={t("activity.runInspector.decisions.listLabel")}
        >
          <For each={result.decisionDisplays}>
            {(receipt) => {
              const selected = selectedReceipt?.selectorId === receipt.selectorId;
              const summary =
                receipt.action.summary ?? `${receipt.action.family} · ${receipt.action.operation}`;
              return (
                <li>
                  <a
                    href={activityRunInspectorSelectorHref(selector, basePath, {
                      id: receipt.selectorId,
                      decisionCursor: state.receiptPageCursors.get(receipt.selectorId),
                    })}
                    aria-current={selected ? "true" : undefined}
                    aria-label={t("activity.runInspector.decisions.inspectLabel", {
                      summary,
                      outcome: decisionOutcomeLabel(receipt.decision.outcome),
                      classification: runInspectorCoverageLabel(receipt.enforcement.coverageState),
                    })}
                  >
                    <span>{summary}</span>
                    <span class="run-inspector__receipt-badges" aria-hidden="true">
                      {renderReceiptBadges(receipt)}
                    </span>
                  </a>
                </li>
              );
            }}
          </For>
        </ol>
      ) : undefined}
      {result.nextDecisionCursor ? (
        renderRunInspectorPagination("decisions", state.decisionPageStatus, onLoadMoreDecisions)
      ) : (
        <div class="run-inspector__pagination" role="note">
          {t("activity.runInspector.decisions.bounded")}
        </div>
      )}
      {selectorId && !selectedReceipt ? (
        <div class="run-inspector__result-state" role="status">
          <h4>{t("activity.runInspector.decisions.notFoundTitle")}</h4>
          <p>{t("activity.runInspector.decisions.notFoundDescription")}</p>
          {selector ? (
            <a href={activityRunInspectorSelectorHref(selector, basePath)}>
              {t("activity.runInspector.decisions.heading")}
            </a>
          ) : undefined}
        </div>
      ) : selectedReceipt ? (
        renderReceiptDetail(selectedReceipt)
      ) : undefined}
    </section>
  );
}
