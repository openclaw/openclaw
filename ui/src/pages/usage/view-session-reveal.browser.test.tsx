import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { registerUsageEnglish } from "../../i18n/locales/en-usage.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "../../styles.css";
import "../../styles/usage.css";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  loadUsagePage,
  settleUsagePage,
  usageButton,
} from "./usage-page.test-support.ts";

registerUsageEnglish();

afterEach(cleanupUsagePageTest);

const inView = (element: Element | null, viewport: Element) => {
  const box = element!.getBoundingClientRect();
  const port = viewport.getBoundingClientRect();
  return box.top >= port.top - 1 && box.top < port.bottom;
};

it("reveals a Recent selection after its report reloads and returns focus to its replacement row", async () => {
  const { page: browser } = await import("vitest/browser");
  await browser.viewport(390, 844);
  const snapshot = cacheSnapshot("fresh");
  const sessions = ["First", "Second"].map((label) => ({
    key: `agent:main:${label}`,
    agentId: "main",
    label,
    usage: { ...snapshot.result.totals, firstActivity: Date.now() },
  }));
  const result = { ...snapshot.result, sessions };
  const reply = deferred<typeof result>();
  let pending = false;
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sessions.usage") {
      return pending && !params?.key ? reply.promise : result;
    }
    return { providers: [], points: [], logs: [] };
  });
  const { page } = await loadUsagePage(request);
  const scroller = page.element;
  scroller.style.cssText = "height: 100vh; overflow: auto";
  const spacer = document.createElement("div");
  spacer.style.height = "3000px";
  scroller.append(spacer);
  const rowButton = (label: string) => usageButton(page, label, ".session-bar-selection");
  for (const label of ["First", "Second"]) {
    rowButton(label).click();
    await settleUsagePage(page);
    page.querySelector<HTMLButtonElement>(".session-detail-close")!.click();
    await settleUsagePage(page);
  }
  usageButton(page, "Recently viewed").click();
  await settleUsagePage(page);
  expect([...page.querySelectorAll(".session-bar-title")].map((row) => row.textContent)).toEqual([
    "Second",
    "First",
  ]);

  const originalButton = rowButton("First");
  const originalRow = originalButton.closest<HTMLElement>(".session-bar-row")!;
  originalRow.scrollIntoView({ block: "center" });
  pending = true;
  originalButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  originalButton.click();
  await waitForSolid(() => {
    expect(page.usageLoading).toBe(true);
    expect(originalRow.isConnected).toBe(false);
    expect(page.querySelector(".usage-grid")).toBeNull();
  });
  expect(
    request.mock.calls.findLast(
      ([method, params]) => method === "sessions.usage" && !params?.key,
    )?.[1],
  ).toMatchObject({
    selectedSessions: ["agent:main:First"],
    recentKeys: ["agent:main:First", "agent:main:Second"],
  });

  scroller.scrollTop = 0;
  pending = false;
  reply.resolve(result);
  await waitForSolid(() => {
    expect(page.querySelector(".session-detail-title")?.textContent).toContain("First");
    expect(inView(page.querySelector(".session-detail-panel"), scroller)).toBe(true);
  });
  const replacementButton = rowButton("First");
  const replacementRow = replacementButton.closest<HTMLElement>(".session-bar-row")!;
  expect(replacementButton).not.toBe(originalButton);
  scroller.scrollTop += 400;
  page.querySelector<HTMLButtonElement>(".session-detail-close")!.click();
  await waitForSolid(() => {
    expect(page.querySelector(".session-detail-panel")).toBeNull();
    expect(inView(replacementRow, scroller)).toBe(true);
    expect(document.activeElement).toBe(replacementButton);
  });
});
