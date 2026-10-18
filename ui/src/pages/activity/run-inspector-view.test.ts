/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { PrincipalRefV1 } from "../../../../packages/gateway-protocol/src/schema/audit-run.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { RunInspectorResult, RunInspectorState } from "./run-inspector-model.ts";
import { renderRunInspector } from "./run-inspector-view.tsx";

const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
const expired = [{ code: "run_again_after_expiry", text: "Run it again." }];
const missingEvidence = ["identity.context"];
function principal(kind: PrincipalRefV1["kind"]): PrincipalRefV1 {
  return { kind, domainRef: hmacRef, principalRef: hmacRef };
}

const presentResult: RunInspectorResult = {
  schemaVersion: 1,
  run: { runId: "run-1", executionId: "execution-1", status: "known" },
  identity: {
    state: "present",
    context: {
      schemaVersion: 1,
      contextId: "context-1",
      executionId: "execution-1",
      runId: "run-1",
      createdAt: 1,
      trustDomain: { kind: "gateway-cell", domainRef: hmacRef, state: "present" },
      invoker: { state: "absent" },
      ingress: { kind: "local-cli", boundary: "cli", sourceRef: hmacRef, state: "present" },
      agentPrincipal: { ...principal("agent"), principalRef: "main", displayLabel: "Main" },
      agentDefinition: { definitionRef: "main", state: "unknown" },
      runtimeInstance: { runtimeRef: hmacRef, kind: "embedded", state: "unsupported" },
      representedSubject: { principal: principal("person"), state: "unknown" },
      sponsor: { principal: principal("service"), state: "unsupported" },
      applicableGrants: [{ grantRef: hmacRef, state: "absent" }],
      assurance: [{ kind: "runtime-binding", evidenceRef: hmacRef, strength: "boundary-verified" }],
      lineage: { parentRunId: "parent-run", depth: 1 },
      coverageState: "unattributed",
      missingEvidence: ["invoker.principal"],
    },
  },
  decisionDisplays: [
    {
      schemaVersion: 1,
      selectorId: "receipt-1",
      occurredAt: 1,
      action: { family: "run", operation: "admission", summary: "Admission" },
      decision: { outcome: "not-applicable", reasonCode: "identity_not_evaluated" },
      enforcement: {
        coverageState: "unattributed",
        policyCount: 0,
        grantCount: 0,
        contextFieldsUsed: [],
      },
      provenance: { state: "verified", producer: "run-admission" },
      missingEvidence: ["invoker.principal"],
      remediation: [{ code: "no_authorization", text: "Do not treat this as authorization." }],
    },
  ],
  coverage: { state: "unattributed", missingEvidence: ["invoker.principal"] },
  nextDecisionCursor: "1",
};

const unavailableResult = (
  state: "unknown" | "unsupported",
  reasonCode: string,
  remediation: Array<{ code: string; text: string }> = [],
): RunInspectorResult => ({
  schemaVersion: 1,
  run: { runId: "run-1", status: state === "unknown" ? "unknown" : "known" },
  identity: { state, reasonCode, missingEvidence, remediation },
  decisionDisplays: [],
  coverage: { state, missingEvidence },
});

const ready = (
  result: RunInspectorResult,
  executionPageStatus?: "loading" | "error",
): RunInspectorState => ({
  status: "ready",
  result,
  executionPageStatus,
  receiptPageCursors: new Map(),
});

function renderState(
  state: RunInspectorState | (() => RunInspectorState),
  onLoadMoreExecutions = vi.fn(),
) {
  const { container } = mountSolid(() =>
    renderRunInspector({
      basePath: "/operator",
      get state() {
        return typeof state === "function" ? state() : state;
      },
      selector: { kind: "run" as const, id: "run-1" },
      selectorId: null,
      onLoadMoreDecisions: vi.fn(),
      onLoadMoreExecutions,
      onRestart: vi.fn(),
      onRetry: vi.fn(),
    }),
  );
  flush();
  return container;
}

it("updates inspection content when the selected run changes", () => {
  const [state, setState] = createSignal<RunInspectorState>({
    status: "loading",
    waitingForGateway: false,
  });

  const container = renderState(state);
  expect(container.textContent).toContain("Loading run inspection");

  setState(ready(presentResult));
  flush();
  expect(container.textContent).toContain("Trust domain");
  expect(container.querySelector("[data-run-id]")?.getAttribute("data-run-id")).toBe("run-1");
  expect(container.textContent).not.toContain("Loading run inspection");

  setState({ status: "empty" });
  flush();
  expect(container.textContent).toContain("No run selected");
  expect(container.querySelector("[data-run-id]")).toBeNull();
});

it("renders every identity dimension with explicit text states and safe refs", () => {
  const container = renderState(ready(presentResult));

  expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
    "Inspection coverage: Unattributed",
  );
  const text = container.textContent ?? "";
  for (const label of [
    "Trust domain",
    "Ingress",
    "Invoker",
    "Represented subject",
    "Sponsor",
    "Agent principal",
    "Agent definition",
    "Runtime instance",
    "Applicable grant 1",
    "Assurance evidence 1",
    "Lineage",
    hmacRef,
    "Additional decision receipts are available",
    "Not applicable",
    "Unattributed",
    "identity_not_evaluated",
    "Verified producer",
    "run-admission",
    "Do not treat this as authorization.",
    "Best-effort audit warning",
  ]) {
    expect(text).toContain(label);
  }
  for (const state of ["Present", "Absent", "Unknown", "Unsupported"]) {
    expect(text).toContain(state);
    expect(container.querySelector(`[aria-label="Evidence state: ${state}"]`)).not.toBeNull();
  }
  for (const ref of ["receipt-1", "context-1", "execution-1"]) {
    expect(text).not.toContain(ref);
  }
  expect(
    container.querySelector<HTMLAnchorElement>('a[href*="view=run"]')?.getAttribute("href"),
  ).toBe("/operator/activity?view=run&run=parent-run");
});

it.each<[RunInspectorState, string]>([
  [{ status: "loading", waitingForGateway: true }, "Waiting for the Gateway"],
  [{ status: "disconnected" }, "Gateway disconnected"],
  [{ status: "unauthorized" }, "Operator read access required"],
  [{ status: "unsupported" }, "Run inspection unsupported"],
  [{ status: "error", recovery: "retry" }, "Run inspection failed"],
])("renders the explicit panel state", (state, expected) => {
  expect(renderState(state).textContent).toContain(expected);
});

it("renders the localized restart control with its accessible name", () => {
  const button = renderState({ status: "error", recovery: "restart" }).querySelector("button");
  expect(button?.textContent?.trim()).toBe("Restart inspection");
});

type Diagnostic = [Parameters<typeof unavailableResult>[0], string, string, typeof expired?];
it.each<Diagnostic>([
  ["unknown", "run_not_found", "Run not found"],
  ["unsupported", "identity_context_unavailable", "Identity evidence expired", expired],
  ["unknown", "identity_context_corrupt", "Identity evidence is corrupt"],
  ["unsupported", "identity_context_unavailable", "Identity evidence unsupported"],
])("renders the Gateway's typed diagnostic state", (state, reason, expected, steps) => {
  expect(renderState(ready(unavailableResult(state, reason, steps))).textContent).toContain(
    expected,
  );
});

it("links an ambiguous run candidate to exact execution inspection", () => {
  const result: RunInspectorResult = {
    ...unavailableResult("unknown", "execution_selection_required"),
    run: { runId: "ambiguous-run", status: "known" },
    identity: {
      state: "ambiguous",
      reasonCode: "execution_selection_required",
      candidates: [{ executionId: "execution:a/b", contextId: "candidate-context", createdAt: 1 }],
      missingEvidence: ["execution.selection"],
      remediation: [],
    },
    coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
    nextExecutionCursor: "opaque-cursor",
  };

  const onLoadMoreExecutions = vi.fn();
  const container = renderState(ready(result), onLoadMoreExecutions);
  const link = container.querySelector<HTMLAnchorElement>('a[href*="execution="]');
  expect(link?.textContent).toContain("execution:a/b");
  expect(link?.getAttribute("href")).toBe(
    "/operator/activity?view=run&execution=execution%3Aa%2Fb",
  );
  container.querySelector("button")?.click();
  expect(onLoadMoreExecutions).toHaveBeenCalledOnce();

  const loading = renderState(ready(result, "loading"));
  expect(loading.querySelector("button")).toMatchObject({
    disabled: true,
    textContent: "Loading executions…",
  });

  const failed = renderState(ready(result, "error"));
  expect(failed.querySelector('[role="alert"]')?.textContent).toContain(
    "More executions could not be loaded",
  );
});
