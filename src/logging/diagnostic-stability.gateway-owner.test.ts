import { afterEach, expect, test } from "vitest";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";

afterEach(() => {
  stopDiagnosticStabilityRecorder();
  resetDiagnosticStabilityRecorderForTest();
  resetDiagnosticEventsForTest();
});

test("keeps private Gateway owner/admission observations out of support bundles", async () => {
  resetDiagnosticEventsForTest();
  resetDiagnosticStabilityRecorderForTest();
  startDiagnosticStabilityRecorder();
  const events = [
    { type: "gateway.admission", method: "gateway.restart.request", outcome: "emitted" },
    { type: "gateway.run.owner", phase: "before_tool_call", gatewayOwner: "match" },
  ] as const;
  for (const event of events) {
    emitDiagnosticEvent(event);
    emitTrustedDiagnosticEvent(event);
  }
  emitDiagnosticEvent({ type: "webhook.received", channel: "test", updateType: "fixture" });
  await waitForDiagnosticEventsDrained();
  const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });
  expect(snapshot.events.map((event) => event.type)).toEqual(["webhook.received"]);
});
