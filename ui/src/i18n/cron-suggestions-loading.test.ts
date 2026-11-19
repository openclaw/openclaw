/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("loads schedule validation copy with the schedule owner", async () => {
  const { manager } = await loadI18n();
  expect(manager.t("cron.errors.invalidRunTime")).toBe("cron.errors.invalidRunTime");

  const { buildCronSchedule } = await import("../lib/cron/form-schedule.ts");
  const { DEFAULT_CRON_FORM } = await import("../lib/cron/state.ts");
  expect(() =>
    buildCronSchedule({ ...DEFAULT_CRON_FORM, scheduleKind: "at", scheduleAt: "invalid" }),
  ).toThrow("Invalid run time.");
});

it("loads payload validation copy with the payload owner", async () => {
  const { manager } = await loadI18n();
  expect(manager.t("cron.errors.systemEventTextRequired")).toBe(
    "cron.errors.systemEventTextRequired",
  );

  const { buildCronPayload } = await import("../lib/cron/payload.ts");
  const { DEFAULT_CRON_FORM } = await import("../lib/cron/state.ts");
  expect(() =>
    buildCronPayload(
      { ...DEFAULT_CRON_FORM, payloadKind: "systemEvent", payloadText: "" },
      null,
      false,
    ),
  ).toThrow("System event text required.");
});

it("loads run outcome copy with the feedback owner", async () => {
  const { manager } = await loadI18n();
  expect(manager.t("cron.runNotStarted.alreadyRunning")).toBe("cron.runNotStarted.alreadyRunning");

  const { cronRunNotStartedMessage } = await import("../lib/cron/run-feedback.ts");
  expect(cronRunNotStartedMessage({ ok: true, ran: false, reason: "already-running" })).toBe(
    "This automation is already running.",
  );
});
