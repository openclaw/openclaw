import { describe, expect, it } from "vitest";
import { translateLegacyQueueDecision } from "./translate.js";

describe("translateLegacyQueueDecision", () => {
  it("maps interrupt to abort_and_replace", () => {
    expect(translateLegacyQueueDecision("interrupt")).toMatchObject({
      relation: "new_task_replace",
      action: "abort_and_replace",
      classifierKind: "legacy_queue_translation",
    });
  });

  it("maps steer modes to same_task_correction", () => {
    expect(translateLegacyQueueDecision("steer")).toMatchObject({
      relation: "same_task_correction",
      action: "steer",
    });
    expect(translateLegacyQueueDecision("steer-backlog")).toMatchObject({
      relation: "same_task_correction",
      action: "steer",
    });
  });

  it("maps collect and followup to same_task_supplement", () => {
    expect(translateLegacyQueueDecision("collect")).toMatchObject({
      relation: "same_task_supplement",
      action: "append",
    });
    expect(translateLegacyQueueDecision("followup")).toMatchObject({
      relation: "same_task_supplement",
      action: "append",
    });
  });

  it("maps queue to background defer", () => {
    expect(translateLegacyQueueDecision("queue")).toMatchObject({
      relation: "background_relevant",
      action: "defer",
    });
  });
});
