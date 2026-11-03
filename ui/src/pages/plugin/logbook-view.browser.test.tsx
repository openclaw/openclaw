import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import "../../styles/base.css";
import { Logbook } from "./logbook-view.tsx";
import { logbookClient, logbookStatus, logbookTimeline } from "./logbook.test-support.ts";
const neverRetired = new Promise<void>(() => {});

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

it.each([
  { locale: "en", width: 1000, expected: "12:00 AM–12:10 AM" },
  { locale: "de", width: 1000, expected: "00:00–00:10" },
  { locale: "en", width: 769, expected: "12:00 AM–12:10 AM" },
  { locale: "en", width: 768, expected: "12:00 AM–12:10 AM" },
] as const)(
  "keeps the $locale time range separate at $width px",
  async ({ locale, width, expected }) => {
    await page.viewport(width, 700);
    vi.spyOn(i18n, "getLocale").mockReturnValue(locale);
    const day = "2026-01-01";
    const status = logbookStatus(day);
    const timeline = logbookTimeline(day, [
      {
        startMs: Date.UTC(2026, 0, 1, 0, 0),
        endMs: Date.UTC(2026, 0, 1, 0, 10),
        title: "Reviewing the synthetic example project and its implementation notes ".repeat(4),
        summary: "Synthetic activity for timestamp layout validation.",
      },
    ]);
    const request = vi.fn(async (method: string) =>
      method === "logbook.status" ? status : timeline,
    );
    const client = logbookClient(request);
    const { container } = mountSolid(() => (
      <Logbook initialClient={client} getRetired={() => neverRetired} />
    ));
    await waitForSolid(() =>
      expect(container.querySelector(".logbook-card__header")).not.toBeNull(),
    );
    flush();

    const header = container.querySelector<HTMLElement>(".logbook-card__header")!;
    const time = header.querySelector<HTMLElement>(".logbook-card__time")!;
    const stripe = header.querySelector<HTMLElement>(".logbook-card__stripe")!;
    const title = header.querySelector<HTMLElement>(".logbook-card__title")!;
    const meta = header.querySelector<HTMLElement>(".logbook-card__meta")!;
    const stripeRect = stripe.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    expect(time.textContent?.trim()).toBe(expected);
    if (width <= 768) {
      expect(getComputedStyle(time).display).toBe("none");
      expect(getComputedStyle(meta).display).toBe("none");
    } else {
      const range = document.createRange();
      range.selectNodeContents(time);
      expect(range.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(range.getBoundingClientRect().right).toBeLessThanOrEqual(stripeRect.left);
    }
    expect(stripeRect.width).toBeGreaterThan(0);
    expect(titleRect.left).toBeGreaterThan(stripeRect.right);
    expect(titleRect.right).toBeLessThanOrEqual(header.getBoundingClientRect().right);
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(title).overflow).toBe("hidden");
  },
);
