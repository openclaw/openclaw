import { describe, expect, it } from "vitest";
import {
  isWebPushQuietHours,
  normalizeWebPushDevicePreferences,
  normalizeWebPushNotificationPreferences,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "./push-web-preferences.js";

describe("Web Push notification preferences", () => {
  it("keeps new attention categories opt-in while preserving approval notifications", () => {
    const preferences = normalizeWebPushNotificationPreferences(undefined);
    expect(preferences.categories).toEqual({
      approvalRequested: true,
      agentFinished: false,
      agentQuestion: false,
      humanMentioned: false,
      scheduledTaskFailed: false,
    });
  });

  it("applies per-device overrides without changing user defaults", () => {
    const defaults = normalizeWebPushNotificationPreferences(undefined);
    const user = {
      ...defaults,
      categories: {
        ...defaults.categories,
        agentQuestion: true,
      },
      detailLevel: "identified" as const,
    };
    const effective = resolveEffectiveWebPushPreferences({
      user,
      device: {
        enabled: true,
        label: "Slot 1",
        categories: { agentQuestion: false, scheduledTaskFailed: true, humanMentioned: true },
      },
    });

    expect(effective.label).toBe("Slot 1");
    expect(effective.detailLevel).toBe("identified");
    expect(webPushCategoryEnabled(effective, "agent-question")).toBe(false);
    expect(webPushCategoryEnabled(effective, "scheduled-task-failed")).toBe(true);
    expect(webPushCategoryEnabled(effective, "human-mentioned")).toBe(true);
    expect(user.categories.agentQuestion).toBe(true);
    expect(user.categories.humanMentioned).toBe(false);
  });

  it.each([
    { detailLevel: "detailed", consent: undefined },
    { detailLevel: "detailed", consent: true },
    { detailLevel: "detailed", consent: "1" },
    { detailLevel: "detailed", consent: 0 },
    { detailLevel: "detailed", consent: 2 },
    { detailLevel: "private", consent: 1 },
    { detailLevel: "identified", consent: 1 },
    { detailLevel: undefined, consent: 1 },
  ])(
    "excludes content without current explicit Detailed consent: %j",
    ({ detailLevel, consent }) => {
      const source = {
        detailLevel,
        answerPreviewConsentVersion: consent,
        questionPreviewConsentVersion: consent,
      };
      for (const preferences of [
        normalizeWebPushNotificationPreferences(source),
        normalizeWebPushDevicePreferences(source),
      ]) {
        expect(preferences).not.toHaveProperty("answerPreviewConsentVersion");
        expect(preferences).not.toHaveProperty("questionPreviewConsentVersion");
      }
    },
  );

  it.each([
    { device: {}, answer: 1, question: 1 },
    { device: { detailLevel: "detailed" }, answer: undefined, question: undefined },
    {
      device: { detailLevel: "detailed", answerPreviewConsentVersion: 1 },
      answer: 1,
      question: undefined,
    },
    {
      device: { detailLevel: "detailed", questionPreviewConsentVersion: 1 },
      answer: undefined,
      question: 1,
    },
    {
      device: { detailLevel: "private", answerPreviewConsentVersion: 1 },
      answer: undefined,
      question: undefined,
    },
  ])("uses consent from the detail-level owner: %j", ({ device, answer, question }) => {
    const effective = resolveEffectiveWebPushPreferences({
      user: {
        detailLevel: "detailed",
        answerPreviewConsentVersion: 1,
        questionPreviewConsentVersion: 1,
      },
      device,
    });
    expect(effective.answerPreviewConsentVersion).toBe(answer);
    expect(effective.questionPreviewConsentVersion).toBe(question);
  });

  it("does not restore cleared consent when Detailed is selected again", () => {
    for (const normalize of [
      normalizeWebPushNotificationPreferences,
      normalizeWebPushDevicePreferences,
    ]) {
      const privatePreferences = normalize({
        detailLevel: "private",
        answerPreviewConsentVersion: 1,
        questionPreviewConsentVersion: 1,
      });
      const detailedPreferences = normalize({ ...privatePreferences, detailLevel: "detailed" });
      expect(detailedPreferences).not.toHaveProperty("answerPreviewConsentVersion");
      expect(detailedPreferences).not.toHaveProperty("questionPreviewConsentVersion");
    }
  });

  it("handles overnight quiet hours in the configured time zone", () => {
    const defaults = normalizeWebPushNotificationPreferences(undefined);
    const effective = resolveEffectiveWebPushPreferences({
      user: {
        ...defaults,
        quietHours: {
          enabled: true,
          startMinute: 22 * 60,
          endMinute: 7 * 60,
          timeZone: "America/Chicago",
        },
      },
    });
    expect(isWebPushQuietHours(effective, Date.parse("2026-08-28T04:30:00Z"))).toBe(true);
    expect(isWebPushQuietHours(effective, Date.parse("2026-08-28T18:00:00Z"))).toBe(false);
  });

  it("normalizes device labels and agent allowlists", () => {
    const device = normalizeWebPushDevicePreferences({
      enabled: true,
      label: "  Production  ",
      agentIds: ["main", "main", "research"],
    });
    const effective = resolveEffectiveWebPushPreferences({ device });
    expect(device.label).toBe("Production");
    expect(effective.agentIds).toEqual(["main", "research"]);
    expect(webPushAgentAllowed(effective, "main")).toBe(true);
    expect(webPushAgentAllowed(effective, "other")).toBe(false);
  });
});
