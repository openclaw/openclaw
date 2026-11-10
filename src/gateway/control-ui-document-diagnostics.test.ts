import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { startControlUiDocumentDiagnostics } from "./control-ui-document-diagnostics.js";

afterEach(() => {
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

it("retains completed stage intervals while clipping unfinished work at response submission", async () => {
  resetDiagnosticEventsForTest();
  const phases: Extract<DiagnosticEventPayload, { type: "diagnostic.phase.completed" }>[] = [];
  onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type === "diagnostic.phase.completed") {
        phases.push(event);
      }
    },
    { includeTrusted: ["diagnostic.phase.completed"] },
  );
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Date, "now").mockImplementation(() => performance.timeOrigin + now);
  const diagnostics = startControlUiDocumentDiagnostics(now)!;
  now = 105;
  const auth = diagnostics.scope("auth_grants");
  now = 110;
  auth[Symbol.dispose]();
  const identity = diagnostics.scope("identity_avatar");
  now = 112;
  const preferences = diagnostics.scope("preferences");
  now = 118;
  preferences[Symbol.dispose]();
  now = 120;
  identity[Symbol.dispose]();
  await waitForDiagnosticEventsDrained();
  expect(phases).toEqual([]);
  now = 125;
  const render = diagnostics.scope("render");
  now = 140;
  diagnostics[Symbol.dispose]();
  now = 150;
  render[Symbol.dispose]();
  await waitForDiagnosticEventsDrained();
  expect(phases).toHaveLength(5);
  for (const [stage, start, end] of [
    ["auth_grants", 105, 110],
    ["identity_avatar", 110, 120],
    ["preferences", 112, 118],
    ["render", 125, 140],
    ["total", 100, 140],
  ] as const) {
    const phase = phases.find((event) => event.name === `control-ui.document.${stage}`)!;
    expect(phase.startedAt).toBeCloseTo(performance.timeOrigin + start, 3);
    expect(phase.endedAt).toBeCloseTo(performance.timeOrigin + end, 3);
    expect(phase.durationMs).toBe(end - start);
  }
});
