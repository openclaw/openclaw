import { createMemo } from "@solidjs/signals";
import { For } from "solid-js";
import type {
  ExecutionIdentityContextV1,
  PrincipalRefV1,
} from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import {
  renderRunInspectorDecisions,
  renderRunInspectorMissingEvidence,
  renderRunInspectorPagination,
  renderRunInspectorRemediation,
  renderRunInspectorSafeRef,
  renderRunInspectorValues,
  runInspectorCoverageKey,
  runInspectorCoverageLabel,
} from "./run-inspector-evidence-view.tsx";
import {
  activityRunInspectorSelectorHref,
  classifyRunInspection,
  type RunInspectorResult,
  type RunInspectorSelector,
  type RunInspectorState,
} from "./run-inspector-model.ts";
import "./run-inspector.css";

registerEnglishCatalog(registerActivityEnglish);

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

type FactValue = [labelKey: string, value: string | number, mono?: boolean, href?: string];

type IdentityFact = {
  label: string;
  state: EvidenceState;
  values?: FactValue[];
  reason?: string;
};

function principalValues(principal: PrincipalRefV1 | undefined): FactValue[] {
  if (!principal) {
    return [];
  }
  return [
    ...optionalReferenceValue("label", principal.displayLabel, false),
    ["kind", principal.kind],
    ["principalReference", principal.principalRef, true],
    ["domainReference", principal.domainRef, true],
  ];
}

function optionalReferenceValue(
  label: string,
  value: string | undefined,
  mono = true,
  href?: string,
): FactValue[] {
  return value ? [[label, value, mono, href]] : [];
}

function renderFact(fact: IdentityFact) {
  const values = fact.values ?? [];
  const stateLabel = t(`activity.runInspector.evidenceState.${fact.state}`);
  const reason =
    fact.reason ??
    (fact.state === "present"
      ? undefined
      : t(`activity.runInspector.reasons.${fact.state}`, { label: fact.label.toLowerCase() }));
  return (
    <div class="run-inspector__fact" data-state={fact.state}>
      <dt>
        <span>{fact.label}</span>
        <span
          class={`run-inspector__state run-inspector__state--${fact.state}`}
          role="img"
          aria-label={t("activity.runInspector.evidenceStateLabel", {
            state: stateLabel,
          })}
        >
          {stateLabel}
        </span>
      </dt>
      <dd>
        {values.length > 0
          ? renderRunInspectorValues(
              "values",
              values.map(([labelKey, value, mono, href]) => [
                labelKey,
                renderRunInspectorSafeRef(value, mono, href),
              ]),
            )
          : undefined}
        {reason ? <p class="run-inspector__reason">{reason}</p> : undefined}
      </dd>
    </div>
  );
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
        ["kind", context.trustDomain.kind],
        ["domainReference", context.trustDomain.domainRef, true],
      ],
    },
    {
      label: t("activity.runInspector.facts.ingress"),
      state: context.ingress.state,
      values: [
        ["kind", context.ingress.kind],
        ["owningBoundary", context.ingress.boundary, true],
        ...optionalReferenceValue("sourceReference", context.ingress.sourceRef),
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
        ...optionalReferenceValue("relationshipReference", sponsor?.relationshipRef),
      ],
    },
    {
      label: t("activity.runInspector.facts.agentDefinition"),
      state: context.agentDefinition.state,
      values: [
        ["definitionReference", context.agentDefinition.definitionRef, true],
        ...optionalReferenceValue("revisionReference", context.agentDefinition.revisionRef),
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
        ["kind", context.runtimeInstance.kind],
        ["runtimeReference", context.runtimeInstance.runtimeRef, true],
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
          values: [["grantReference", grant.grantRef, true]],
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
            ["kind", assurance.kind],
            ["strength", assurance.strength],
            ["evidenceReference", assurance.evidenceRef, true],
          ],
        }))),
    {
      label: t("activity.runInspector.facts.lineage"),
      state: lineage ? "present" : "absent",
      values: lineage
        ? [
            ["depth", lineage.depth],
            ...optionalReferenceValue(
              "parentRunReference",
              lineage.parentRunId,
              true,
              lineage.parentRunId
                ? activityRunInspectorSelectorHref(
                    { kind: "run", id: lineage.parentRunId },
                    basePath,
                  )
                : undefined,
            ),
            ...optionalReferenceValue("parentExecutionReference", lineage.parentExecutionId),
            ...optionalReferenceValue("parentContextReference", lineage.parentContextId),
            ...optionalReferenceValue("delegationReference", lineage.delegationRef),
            ...principalValues(lineage.parentAgentPrincipal),
          ]
        : [],
      reason: lineage ? undefined : t("activity.runInspector.reasons.noLineage"),
    },
  ];
}

function renderUnavailableResult(
  result: RunInspectorResult,
  basePath: string,
  executionPageStatus: "loading" | "error" | undefined,
  onLoadMoreExecutions: () => void,
) {
  if (result.identity.state === "present") {
    return undefined;
  }
  const kind = classifyRunInspection(result);
  const key = kind === "not-found" ? "notFound" : kind;
  const title = t(`activity.runInspector.diagnostic.${key}.title`);
  const identity = result.identity;
  return (
    <>
      <div class="run-inspector__result-state" role="status" aria-label={title}>
        <h3>{title}</h3>
        <p>{t(`activity.runInspector.diagnostic.${key}.description`)}</p>
        <p>
          {t("activity.runInspector.diagnosticReason")}
          {renderRunInspectorSafeRef(identity.reasonCode, true)}
        </p>
      </div>
      {identity.state === "ambiguous" ? (
        <>
          <ol
            class="run-inspector__candidate-list"
            aria-label={t("activity.runInspector.candidates.listLabel")}
          >
            <For each={identity.candidates} keyed={(candidate) => candidate.executionId}>
              {(candidate) => (
                <li>
                  <span>
                    {t("activity.runInspector.candidates.recorded", {
                      date: new Date(candidate().createdAt).toLocaleString(),
                    })}
                  </span>
                  <a
                    href={activityRunInspectorSelectorHref(
                      { kind: "execution", id: candidate().executionId },
                      basePath,
                    )}
                  >
                    {t("activity.runInspector.candidates.executionReference")}
                    {renderRunInspectorSafeRef(candidate().executionId, true)}
                  </a>
                </li>
              )}
            </For>
          </ol>
          {result.nextExecutionCursor
            ? renderRunInspectorPagination("candidates", executionPageStatus, onLoadMoreExecutions)
            : undefined}
        </>
      ) : undefined}
      {renderRunInspectorMissingEvidence(identity.missingEvidence)}
      {renderRunInspectorRemediation(identity.remediation)}
    </>
  );
}

function renderReady(
  props: RunInspectorProps,
  state: Extract<RunInspectorState, { status: "ready" }>,
) {
  const result = state.result;
  const currentCoverageLabel = runInspectorCoverageLabel(result.coverage.state);
  return (
    <>
      <div
        class={`run-inspector__coverage run-inspector__coverage--${result.coverage.state}`}
        role="status"
        aria-label={t("activity.runInspector.coverageStatusLabel", {
          state: currentCoverageLabel,
        })}
      >
        <strong>{currentCoverageLabel}</strong>
        <span>
          {t(
            `activity.runInspector.coverage.${runInspectorCoverageKey(result.coverage.state)}.description`,
          )}
        </span>
      </div>
      {result.identity.state === "present" ? (
        <>
          <section class="run-inspector__section" aria-labelledby="run-inspector-identity-heading">
            <h3 id="run-inspector-identity-heading">
              {t("activity.runInspector.identityHeading")}
            </h3>
            <dl class="run-inspector__facts">
              {identityFacts(result.identity.context, props.basePath).map(renderFact)}
            </dl>
          </section>
          {renderRunInspectorMissingEvidence(result.coverage.missingEvidence)}
          {renderRunInspectorDecisions(
            state,
            props.selector,
            props.selectorId,
            props.basePath,
            props.onLoadMoreDecisions,
          )}
        </>
      ) : (
        renderUnavailableResult(
          result,
          props.basePath,
          state.executionPageStatus,
          props.onLoadMoreExecutions,
        )
      )}
    </>
  );
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
  return (
    <div
      class="run-inspector__panel"
      role={state.status === "error" || state.status === "unauthorized" ? "alert" : "status"}
    >
      <h3>{t(`activity.runInspector.panels.${key}.title`)}</h3>
      <p>{t(`activity.runInspector.panels.${key}.description`)}</p>
      {action ? (
        <button type="button" class="btn" onClick={action.onClick}>
          {action.label}
        </button>
      ) : undefined}
    </div>
  );
}

export function renderRunInspector(props: RunInspectorProps) {
  const identity = createMemo(() => {
    const state = props.state;
    return state.status === "ready" && state.result.identity.state === "present"
      ? state.result.identity.context
      : null;
  });
  const content = createMemo(() => {
    const state = props.state;
    return state.status === "ready" ? renderReady(props, state) : renderPanel(props, state);
  });

  return (
    <section
      id="activity-run-panel"
      class="run-inspector"
      data-run-id={identity()?.runId ?? undefined}
      data-execution-id={identity()?.executionId ?? undefined}
      aria-label={t("activity.runInspector.mode")}
    >
      <div class="settings-section__header">
        <div>
          <h2 class="settings-section__heading">{t("activity.runInspector.mode")}</h2>
          <p class="run-inspector__intro">{t("activity.runInspector.intro")}</p>
        </div>
      </div>
      <div class="run-inspector__warning" role="note">
        {t("activity.runInspector.bestEffortWarning")}
      </div>
      {content()}
    </section>
  );
}
