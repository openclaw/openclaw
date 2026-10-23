import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { RunsSection } from "./view-runs.tsx";
import { createCronViewProps, getElement } from "./view.test-support.ts";

type CronRunsSectionProps = Parameters<typeof RunsSection>[0];

function expectFilters(
  overrides: Partial<CronRunsSectionProps>,
  labels: string[],
  visible?: string[],
) {
  const container = document.createElement("div");
  mountSolid(() => RunsSection({ ...createCronViewProps(), ...overrides }), { container });
  flush();
  const triggers = ["status", "delivery"].map((filter) =>
    getElement(
      container,
      `[data-filter="${filter}"] .cron-filter-dropdown__trigger`,
      HTMLButtonElement,
    ),
  );
  expect(triggers.map((trigger) => trigger.getAttribute("aria-label"))).toEqual(labels);
  if (visible) {
    triggers.forEach((trigger, index) => expect(trigger.textContent).toContain(visible[index]));
  }
}

describe("cron run filter accessibility", () => {
  it("includes active selections in run filter accessible names", () => {
    expectFilters({}, ["Status All statuses", "Delivery All delivery"]);
    expectFilters({ runsStatuses: ["error"], runsDeliveryStatuses: ["delivered"] }, [
      "Status Error",
      "Delivery Delivered",
    ]);
    expectFilters(
      { runsStatuses: ["error", "ok"], runsDeliveryStatuses: ["not-delivered", "delivered"] },
      ["Status OK, Error", "Delivery Delivered, Not delivered"],
      ["OK, Error", "Delivered, Not delivered"],
    );
    expectFilters(
      {
        runsStatuses: ["error", "ok", "skipped"],
        runsDeliveryStatuses: ["delivered", "not-delivered", "unknown"],
      },
      [
        "Status OK +2 (OK, Error, and Skipped)",
        "Delivery Delivered +2 (Delivered, Not delivered, and Unknown)",
      ],
      ["OK +2", "Delivered +2"],
    );
  });

  it("formats translated filter selections using the active app locale", async () => {
    const restoreI18nState = captureI18nStateForTesting();
    try {
      await i18n.setLocale("de");
      expectFilters(
        { runsStatuses: ["error", "ok"], runsDeliveryStatuses: ["not-delivered", "delivered"] },
        ["Status OK, Fehler", "Zustellung Zugestellt, Nicht zugestellt"],
        ["OK, Fehler", "Zugestellt, Nicht zugestellt"],
      );
      expectFilters(
        {
          runsStatuses: ["ok", "error", "skipped"],
          runsDeliveryStatuses: ["delivered", "not-delivered", "unknown"],
        },
        [
          "Status OK +2 (OK, Fehler und Übersprungen)",
          "Zustellung Zugestellt +2 (Zugestellt, Nicht zugestellt und Unbekannt)",
        ],
      );
    } finally {
      await restoreI18nState();
    }
  });

  it("restores shared system-locale mode after a temporary explicit selection", async () => {
    const restoreOriginalState = captureI18nStateForTesting();
    try {
      await i18n.useSystemLocale();
      const systemLocale = i18n.getLocale();
      expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();

      const restoreSystemState = captureI18nStateForTesting();
      await i18n.setLocale("de");
      expect(localStorage.getItem("openclaw.i18n.locale")).toBe("de");

      await restoreSystemState();
      expect(i18n.getLocale()).toBe(systemLocale);
      expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
    } finally {
      await restoreOriginalState();
    }
  });
});
