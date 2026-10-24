/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { presentResult as inspectionFixture } from "../../e2e/activity-run-inspector.test-fixtures.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { RunInspectorResult, RunInspectorState } from "./run-inspector-model.ts";
import { renderRunInspector } from "./run-inspector-view.tsx";

const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
const missingEvidence = ["identity.context"];
const presentResult = inspectionFixture("run-1", "execution-1");
type InspectionRead = Parameters<typeof renderRunInspector>[0]["request"];

const unavailableResult = (
  state: "unknown" | "unsupported",
  reasonCode: string,
): RunInspectorResult => ({
  schemaVersion: 1,
  run: { runId: "run-1", status: state === "unknown" ? "unknown" : "known" },
  identity: { state, reasonCode, missingEvidence, remediation: [] },
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
  request?: () => InspectionRead,
) {
  const { container } = mountSolid(() =>
    renderRunInspector({
      basePath: "/operator",
      get state() {
        return typeof state === "function" ? state() : state;
      },
      get request() {
        return request?.();
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
  });

  const container = renderState(state);
  expect(container.textContent).toContain("Loading run inspection");

  setState(ready(presentResult));
  flush();
  expect(container.textContent).toContain("Trust domain");
  expect(container.querySelector("[data-run-id]")?.getAttribute("data-run-id")).toBe("run-1");
  expect(container.textContent).not.toContain("Loading run inspection");
  for (const label of [
    "Agent definition",
    "Present",
    "Absent",
    "Unknown",
    "Unsupported",
    "Unattributed",
    hmacRef,
    "Not applicable",
    "run_admission_identity_not_evaluated",
    "Verified producer",
    "run-admission",
    "Treat this receipt as attribution only; it does not prove authorization.",
  ]) {
    expect(container.textContent).toContain(label);
  }
  expect(
    container.querySelector<HTMLAnchorElement>('a[href*="view=run"]')?.getAttribute("href"),
  ).toBe("/operator/activity?view=run&run=parent-safe-ref");

  setState({ status: "empty" });
  flush();
  expect(container.textContent).toContain("No run selected");
  expect(container.querySelector("[data-run-id]")).toBeNull();
});

it("labels a generic receipt's selected authority without claiming human intent or verification", () => {
  const result = structuredClone(presentResult);
  const receipt = result.decisionDisplays[0]!;
  receipt.provenance = { state: "unverified" };
  receipt.decision = { outcome: "unknown", reasonCode: "decision_fact_display_unverified" };
  receipt.representedSubject = {
    state: "present",
    principal: { kind: "person", domainRef: hmacRef, principalRef: "recorded-person" },
  };
  const text = renderState(ready(result)).textContent;
  expect(text).toContain("Recorded authority subject");
  expect(text).toContain("recorded-person");
  expect(text).toContain("It does not prove that the person requested or approved it");
  expect(text).not.toContain("Verified producer");
});

it("renders the disconnected panel without retained evidence", () => {
  expect(renderState({ status: "disconnected" }).textContent).toContain("Gateway disconnected");
});

it("renders unsupported identity evidence without inferring expiry", () => {
  expect(
    renderState(ready(unavailableResult("unsupported", "identity_context_unavailable")))
      .textContent,
  ).toContain("Identity evidence unsupported");
});

it("links an ambiguous run candidate to exact execution inspection", async () => {
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

  const completion = Promise.withResolvers<void>();
  const [request, setRequest] = createSignal<InspectionRead>();
  const onLoadMoreExecutions = vi.fn(() => setRequest({ kind: "executions", completion }));
  const container = renderState(ready(result), onLoadMoreExecutions, request);
  const link = container.querySelector<HTMLAnchorElement>('a[href*="execution="]');
  expect(link?.textContent).toContain("execution:a/b");
  expect(link?.getAttribute("href")).toBe(
    "/operator/activity?view=run&execution=execution%3Aa%2Fb",
  );
  container.querySelector("button")?.click();
  flush();
  expect(onLoadMoreExecutions).toHaveBeenCalledOnce();
  expect(container.querySelector("button")).toMatchObject({
    disabled: true,
    textContent: "Loading executions…",
  });
  completion.resolve();
  await waitForSolid(() => expect(container.querySelector("button")?.disabled).toBe(false));

  const failed = renderState(ready(result, "error"));
  expect(failed.querySelector('[role="alert"]')?.textContent).toContain(
    "More executions could not be loaded",
  );
});
