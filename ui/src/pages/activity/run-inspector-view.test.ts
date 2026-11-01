/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { presentResult as inspectionFixture } from "../../e2e/activity-run-inspector.test-fixtures.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { RunInspectorResult, RunInspectorState } from "./run-inspector-model.ts";
import { renderRunInspector } from "./run-inspector-view.tsx";

const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;
const missingEvidence = ["identity.context"];
const presentResult = inspectionFixture("run-1", "execution-1");

const unavailableResult = (reasonCode: string): RunInspectorResult => ({
  schemaVersion: 1,
  run: { runId: "run-1", status: "known" },
  identity: { state: "unsupported", reasonCode, missingEvidence, remediation: [] },
  decisionDisplays: [],
  coverage: { state: "unsupported", missingEvidence },
});

const ready = (result: RunInspectorResult): RunInspectorState => ({
  status: "ready",
  result,
  receiptPageCursors: new Map(),
});

function renderState(state: RunInspectorState) {
  const { container } = mountSolid(() =>
    renderRunInspector({
      basePath: "/operator",
      state,
      selector: { kind: "run" as const, id: "run-1" },
      selectorId: null,
      onLoadMoreDecisions: vi.fn(),
      onLoadMoreExecutions: vi.fn(),
      onRestart: vi.fn(),
      onRetry: vi.fn(),
    }),
  );
  flush();
  return container;
}

it("renders recorded identity, admission evidence, and the mounted parent link", () => {
  const container = renderState(ready(presentResult));
  for (const label of [
    "Agent definition",
    hmacRef,
    "Not applicable",
    "run_admission_identity_not_evaluated",
    "run-admission",
  ]) {
    expect(container.textContent).toContain(label);
  }
  expect(
    container.querySelector<HTMLAnchorElement>('a[href*="view=run"]')?.getAttribute("href"),
  ).toBe("/operator/activity?view=run&run=parent-safe-ref");
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
    renderState(ready(unavailableResult("identity_context_unavailable"))).textContent,
  ).toContain("Identity evidence unsupported");
});
