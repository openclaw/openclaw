import { expect, it } from "vitest";
import {
  getSessionRowSelectionMetrics,
  recordSessionRowSelection,
} from "./gateway-work-metrics.js";

it.each([
  ["gateway.chat.history.session_info", "chat.history"],
  ["gateway.chat.startup.session_info", "chat.startup"],
  ["gateway:session-event", "session-event"],
  ["unknown:session-one", "other"],
  ["unknown:session-two", "other"],
])("attributes %s without exposing identities in metric labels", (input, label) => {
  const counter = () =>
    getSessionRowSelectionMetrics().selections.find(
      (entry) => entry.kind === "exact" && entry.task === label,
    );
  const before = counter();
  recordSessionRowSelection("exact", 3, input);
  expect(counter()).toEqual({
    kind: "exact",
    task: label,
    calls: (before?.calls ?? 0) + 1,
    rows: (before?.rows ?? 0) + 3,
  });
});
