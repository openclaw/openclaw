import { html, nothing } from "lit";
import type {
  ExecutionIdentityContextV1,
  PrincipalRefV1,
} from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { t } from "../../i18n/index.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import {
  renderRunInspectorDecisions,
  renderRunInspectorMissingEvidence,
  renderRunInspectorPagination,
  renderRunInspectorRemediation,
  renderRunInspectorSafeRef,
  runInspectorCoverageKey,
  runInspectorCoverageLabel,
} from "./run-inspector-evidence-view.ts";
import {
  activityRunInspectorSelectorHref,
  classifyRunInspection,
  type RunInspectorResult,
  type RunInspectorSelector,
  type RunInspectorState,
} from "./run-inspector-model.ts";
import "./run-inspector.css";

registerActivityEnglish();

type EvidenceState = "present" | "absent" | "unknown" | "unsupported";

type RunInspectorProps = {
  basePath: string;
  state: RunInspectorState;
  selector: RunInspectorSelector | null;
  selectorId: string | null;
  onLoadMoreDecisions: () => void;
  onLoadMoreExecutions: () => void;
  onRestart: () => void;
  onRetry: () => void;
};

type FactValue = [label: string, value: string | number, mono?: boolean, href?: string];

type IdentityFact = {
  label: string;
  state: EvidenceState;
  values?: FactValue[];
  reason?: string;
};

function evidenceStateLabel(state: EvidenceState): string {
  return t(`activity.runInspector.evidenceState.${state}`);
}

function stateReason(label: string, state: EvidenceState): string | undefined {
  return state === "present"
    ? undefined
    : t(`activity.runInspector.reasons.${state}`, { label: label.toLowerCase() });
}

function principalValues(principal: PrincipalRefV1 | undefined): FactValue[] {
  if (!principal) {
    return [];
  }
  return [
    ...optionalReferenceValue(
      t("activity.runInspector.values.label"),
      principal.displayLabel,
      false,
    ),
    [t("activity.runInspector.values.kind"), principal.kind],
    [t("activity.runInspector.values.principalReference"), principal.principalRef, true],
    [t("activity.runInspector.values.domainReference"), principal.domainRef, true],
  ];
}

function optionalReferenceValue(
  label: string,
  value: string | undefined,
  mono = true,
): FactValue[] {
  return value ? [[label, value, mono]] : [];
}

function renderFact(fact: IdentityFact) {
  const values = fact.values ?? [];
  const reason = fact.reason ?? stateReason(fact.label, fact.state);
  return html`
    <div class="run-inspector__fact" data-state=${fact.state}>
      <dt>
        <span>${fact.label}</span>
        <span
          class="run-inspector__state run-inspector__state--${fact.state}"
          role="img"
          aria-label=${t("activity.runInspector.evidenceStateLabel", {
            state: evidenceStateLabel(fact.state),
          })}
        >
          ${evidenceStateLabel(fact.state)}
        </span>
      </dt>
      <dd>
        ${
          values.length > 0
            ? html`<dl class="run-inspector__values">
                ${values.map(
                  ([label, value, mono, href]) => html`
                    <div>
                      <dt>${label}</dt>
                      <dd>${renderRunInspectorSafeRef(value, mono, href)}</dd>
                    </div>
                  `,
                )}
              </dl>`
            : nothing
        }
        ${reason ? html`<p class="run-inspector__reason">${reason}</p>` : nothing}
      </dd>
    </div>
  `;
}

function identityFacts(context: ExecutionIdentityContextV1, basePath: string): IdentityFact[] {
  const representedSubject = context.representedSubject;
  const sponsor = context.sponsor;
  const lineage = context.lineage;
  return [
    {
      label: t("activity.runInspector.facts.trustDomain"),
      state: context.trustDomain.state,
      values: [
        [t("activity.runInspector.values.kind"), context.trustDomain.kind],
        [t("activity.runInspector.values.domainReference"), context.trustDomain.domainRef, true],
      ],
    },
    {
      label: t("activity.runInspector.facts.ingress"),
      state: context.ingress.state,
      values: [
        [t("activity.runInspector.values.kind"), context.ingress.kind],
        [t("activity.runInspector.values.owningBoundary"), context.ingress.boundary, true],
        ...optionalReferenceValue(
          t("activity.runInspector.values.sourceReference"),
          context.ingress.sourceRef,
        ),
      ],
    },
    {
      label: t("activity.runInspector.facts.invoker"),
      state: context.invoker.state,
      values: principalValues(context.invoker.principal),
      reason:
        context.invoker.state === "absent"
          ? t("activity.runInspector.reasons.invokerAbsent")
          : undefined,
    },
    {
      label: t("activity.runInspector.facts.representedSubject"),
      state: representedSubject?.state ?? "absent",
      values: principalValues(representedSubject?.principal),
    },
    {
      label: t("activity.runInspector.facts.sponsor"),
      state: sponsor?.state ?? "absent",
      values: [
        ...principalValues(sponsor?.principal),
        ...optionalReferenceValue(
          t("activity.runInspector.values.relationshipReference"),
          sponsor?.relationshipRef,
        ),
      ],
    },
    {
      label: t("activity.runInspector.facts.agentDefinition"),
      state: context.agentDefinition.state,
      values: [
        [
          t("activity.runInspector.values.definitionReference"),
          context.agentDefinition.definitionRef,
          true,
        ],
        ...optionalReferenceValue(
          t("activity.runInspector.values.revisionReference"),
          context.agentDefinition.revisionRef,
        ),
      ],
    },
    {
      label: t("activity.runInspector.facts.agentPrincipal"),
      state: "present",
      values: principalValues(context.agentPrincipal),
    },
    {
      label: t("activity.runInspector.facts.runtimeInstance"),
      state: context.runtimeInstance.state,
      values: [
        [t("activity.runInspector.values.kind"), context.runtimeInstance.kind],
        [
          t("activity.runInspector.values.runtimeReference"),
          context.runtimeInstance.runtimeRef,
          true,
        ],
      ],
    },
    ...(context.applicableGrants.length === 0
      ? [
          {
            label: t("activity.runInspector.facts.applicableGrants"),
            state: "absent" as const,
            reason: t("activity.runInspector.reasons.noGrants"),
          },
        ]
      : context.applicableGrants.map((grant, index): IdentityFact => ({
          label: t("activity.runInspector.facts.applicableGrant", { index: String(index + 1) }),
          state: grant.state,
          values: [[t("activity.runInspector.values.grantReference"), grant.grantRef, true]],
        }))),
    ...(context.assurance.length === 0
      ? [
          {
            label: t("activity.runInspector.facts.assuranceEvidence"),
            state: "absent" as const,
            reason: t("activity.runInspector.reasons.noAssurance"),
          },
        ]
      : context.assurance.map((assurance, index): IdentityFact => ({
          label: t("activity.runInspector.facts.assuranceEvidenceItem", {
            index: String(index + 1),
          }),
          state: "present" as const,
          values: [
            [t("activity.runInspector.values.kind"), assurance.kind],
            [t("activity.runInspector.values.strength"), assurance.strength],
            [t("activity.runInspector.values.evidenceReference"), assurance.evidenceRef, true],
          ],
        }))),
    {
      label: t("activity.runInspector.facts.lineage"),
      state: lineage ? "present" : "absent",
      values: lineage
        ? [
            [t("activity.runInspector.values.depth"), lineage.depth],
            ...(lineage.parentRunId
              ? ([
                  [
                    t("activity.runInspector.values.parentRunReference"),
                    lineage.parentRunId,
                    true,
                    activityRunInspectorSelectorHref(
                      { kind: "run", id: lineage.parentRunId },
                      basePath,
                    ),
                  ],
                ] satisfies FactValue[])
              : []),
            ...optionalReferenceValue(
              t("activity.runInspector.values.parentExecutionReference"),
              lineage.parentExecutionId,
            ),
            ...optionalReferenceValue(
              t("activity.runInspector.values.parentContextReference"),
              lineage.parentContextId,
            ),
            ...optionalReferenceValue(
              t("activity.runInspector.values.delegationReference"),
              lineage.delegationRef,
            ),
            ...principalValues(lineage.parentAgentPrincipal),
          ]
        : [],
      reason: lineage ? undefined : t("activity.runInspector.reasons.noLineage"),
    },
  ];
}

function diagnosticCopy(result: RunInspectorResult) {
  const kind = classifyRunInspection(result);
  if (kind === "present") {
    return null;
  }
  const key = kind === "not-found" ? "notFound" : kind;
  return {
    title: t(`activity.runInspector.diagnostic.${key}.title`),
    description: t(`activity.runInspector.diagnostic.${key}.description`),
  };
}

function renderUnavailableResult(
  result: RunInspectorResult,
  basePath: string,
  executionPageStatus: "loading" | "error" | undefined,
  onLoadMoreExecutions: () => void,
) {
  const copy = diagnosticCopy(result);
  if (!copy || result.identity.state === "present") {
    return nothing;
  }
  const identity = result.identity;
  return html`
    <div class="run-inspector__result-state" role="status" aria-label=${copy.title}>
      <h3>${copy.title}</h3>
      <p>${copy.description}</p>
      <p>
        ${t("activity.runInspector.diagnosticReason")}
        ${renderRunInspectorSafeRef(identity.reasonCode, true)}
      </p>
    </div>
    ${
      identity.state === "ambiguous"
        ? html`
            <ol
              class="run-inspector__candidate-list"
              aria-label=${t("activity.runInspector.candidates.listLabel")}
            >
              ${identity.candidates.map(
                (candidate) => html`
                  <li>
                    <span
                      >${t("activity.runInspector.candidates.recorded", {
                        date: new Date(candidate.createdAt).toLocaleString(),
                      })}</span
                    >
                    <a
                      href=${activityRunInspectorSelectorHref(
                        { kind: "execution", id: candidate.executionId },
                        basePath,
                      )}
                    >
                      ${t("activity.runInspector.candidates.executionReference")}
                      ${renderRunInspectorSafeRef(candidate.executionId, true)}
                    </a>
                  </li>
                `,
              )}
            </ol>
            ${
              result.nextExecutionCursor
                ? renderRunInspectorPagination(
                    "candidates",
                    executionPageStatus,
                    onLoadMoreExecutions,
                  )
                : nothing
            }
          `
        : nothing
    }
    ${renderRunInspectorMissingEvidence(identity.missingEvidence)}
    ${renderRunInspectorRemediation(identity.remediation)}
  `;
}

function renderReady(
  state: Extract<RunInspectorState, { status: "ready" }>,
  basePath: string,
  selector: RunInspectorSelector | null,
  selectorId: string | null,
  onLoadMoreDecisions: () => void,
  onLoadMoreExecutions: () => void,
) {
  const result = state.result;
  const currentCoverageLabel = runInspectorCoverageLabel(result.coverage.state);
  return html`
    <div
      class="run-inspector__coverage run-inspector__coverage--${result.coverage.state}"
      role="status"
      aria-label=${t("activity.runInspector.coverageStatusLabel", {
        state: currentCoverageLabel,
      })}
    >
      <strong>${currentCoverageLabel}</strong>
      <span>
        ${t(
          `activity.runInspector.coverage.${runInspectorCoverageKey(result.coverage.state)}.description`,
        )}
      </span>
    </div>
    ${
      result.identity.state === "present"
        ? html`
            <section
              class="run-inspector__section"
              aria-labelledby="run-inspector-identity-heading"
            >
              <h3 id="run-inspector-identity-heading">
                ${t("activity.runInspector.identityHeading")}
              </h3>
              <dl class="run-inspector__facts">
                ${identityFacts(result.identity.context, basePath).map(renderFact)}
              </dl>
            </section>
            ${renderRunInspectorMissingEvidence(result.coverage.missingEvidence)}
            ${renderRunInspectorDecisions(state, selector, selectorId, basePath, onLoadMoreDecisions)}
          `
        : renderUnavailableResult(result, basePath, state.executionPageStatus, onLoadMoreExecutions)
    }
  `;
}

function renderPanel(
  props: RunInspectorProps,
  state: Exclude<RunInspectorState, { status: "ready" }>,
) {
  const key = state.status === "loading" && state.waitingForGateway ? "waiting" : state.status;
  const action =
    state.status === "error"
      ? state.recovery === "restart"
        ? { label: t("activity.runInspector.restart"), onClick: props.onRestart }
        : { label: t("activity.runInspector.retry"), onClick: props.onRetry }
      : undefined;
  return html`
    <div
      class="run-inspector__panel"
      role=${state.status === "error" || state.status === "unauthorized" ? "alert" : "status"}
    >
      <h3>${t(`activity.runInspector.panels.${key}.title`)}</h3>
      <p>${t(`activity.runInspector.panels.${key}.description`)}</p>
      ${
        action
          ? html`<button type="button" class="btn" @click=${action.onClick}>
              ${action.label}
            </button>`
          : nothing
      }
    </div>
  `;
}

export function renderRunInspector(props: RunInspectorProps) {
  const state = props.state;
  const content =
    state.status === "ready"
      ? renderReady(
          state,
          props.basePath,
          props.selector,
          props.selectorId,
          props.onLoadMoreDecisions,
          props.onLoadMoreExecutions,
        )
      : renderPanel(props, state);

  return html`
    <section
      id="activity-run-panel"
      class="run-inspector"
      aria-label=${t("activity.runInspector.mode")}
    >
      <div class="settings-section__header">
        <div>
          <h2 class="settings-section__heading">${t("activity.runInspector.mode")}</h2>
          <p class="run-inspector__intro">${t("activity.runInspector.intro")}</p>
        </div>
      </div>
      <div class="run-inspector__warning" role="note">
        ${t("activity.runInspector.bestEffortWarning")}
      </div>
      ${content}
    </section>
  `;
}
