import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { localDayKey } from "./logbook-state.ts";
import type { LogbookTimelinePayload } from "./logbook-types.ts";
import { Logbook } from "./logbook-view.tsx";

const day = localDayKey();
const neverRetired = new Promise<void>(() => {});
const status = {
  captureEnabled: true,
  capturePaused: false,
  captureIntervalSeconds: 30,
  analysisIntervalMinutes: 15,
  retentionDays: 30,
  pendingFrames: 0,
  analysisRunning: false,
  visionModelSource: "missing",
  today: day,
  todayCards: 0,
  timeZone: "UTC",
};
const empty: LogbookTimelinePayload = {
  day,
  cards: [],
  stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
};
afterEach(cleanupSolid);

it("keeps the side editor usable while a delayed timeline fails and retries", async () => {
  const pending = createDeferred<LogbookTimelinePayload>();
  let retry = false;
  const request = vi.fn((method: string) =>
    method === "logbook.status" ? status : retry ? empty : pending.promise,
  );
  const view = mountSolid(() => (
    <Logbook initialClient={createTestGatewayClient(request)} getRetired={() => neverRetired} />
  ));
  await waitForSolid(() =>
    expect(view.container.querySelector(".logbook__timeline")?.textContent).toContain("Loading"),
  );
  const input = view.container.querySelector<HTMLInputElement>(".logbook-ask__input")!;
  input.value = "Keep this question";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  pending.reject(new Error("Timeline unavailable"));
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toContain("Timeline unavailable"),
  );
  retry = true;
  view.container.querySelector<HTMLButtonElement>(".logbook__actions button:last-child")!.click();
  await waitForSolid(() => expect(view.container.querySelector(".logbook__empty")).not.toBeNull());
  expect(view.container.querySelector(".logbook-ask__input")).toBe(input);
  expect(input.value).toBe("Keep this question");
});

it("keeps an expanded card mounted while a foreground refresh is pending", async () => {
  const refresh = createDeferred<LogbookTimelinePayload>();
  const timeline: LogbookTimelinePayload = {
    ...empty,
    cards: [
      {
        id: 1,
        day,
        startMs: 1,
        endMs: 2,
        title: "Synthetic work",
        summary: "Summary",
        detail: "Retained detail",
        category: "Coding",
        distractions: [],
      },
    ],
  };
  let loaded = false;
  const request = vi.fn((method: string) => {
    if (method === "logbook.status") {
      return status;
    }
    if (loaded) {
      return refresh.promise;
    }
    loaded = true;
    return timeline;
  });
  const view = mountSolid(() => (
    <Logbook initialClient={createTestGatewayClient(request)} getRetired={() => neverRetired} />
  ));
  await waitForSolid(() =>
    expect(view.container.querySelector(".logbook-card__header")).not.toBeNull(),
  );
  const card = view.container.querySelector<HTMLButtonElement>(".logbook-card__header")!;
  card.click();
  flush();
  view.container.querySelector<HTMLButtonElement>(".logbook__actions button:last-child")!.click();
  flush();
  expect(view.container.querySelector(".logbook-card__header")).toBe(card);
  expect(view.container.querySelector(".logbook-card__detail")?.textContent).toContain(
    "Retained detail",
  );
  refresh.resolve({ ...timeline, cards: [{ ...timeline.cards[0]!, title: "Updated work" }] });
  await waitForSolid(() => expect(card.textContent).toContain("Updated work"));
  expect(view.container.querySelector(".logbook-card__header")).toBe(card);
  expect(view.container.querySelector(".logbook-card__detail")?.textContent).toContain(
    "Retained detail",
  );
});
