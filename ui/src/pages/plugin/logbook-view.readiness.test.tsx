import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { localDayKey } from "./logbook-state.ts";
import type { LogbookTimelinePayload } from "./logbook-types.ts";
import { Logbook } from "./logbook-view.tsx";
import { logbookStatus, logbookTimeline } from "./logbook.test-support.ts";

const day = localDayKey();
const neverRetired = new Promise<void>(() => {});
const status = logbookStatus(day, { todayCards: 0 });
const empty = logbookTimeline(day);
afterEach(cleanupSolid);

function mountLogbook(request: (method: string) => unknown) {
  return mountSolid(() => (
    <Logbook initialClient={createTestGatewayClient(request)} getRetired={() => neverRetired} />
  ));
}

it("shows both shared keyframes as pending until their one request resolves", async () => {
  const frame = createDeferred<{ format: string; base64: string }>();
  const timeline = logbookTimeline(day, [
    { id: 1, title: "First card", keyframeId: 42 },
    { id: 2, title: "Shared frame", keyframeId: 42 },
  ]);
  const frameRequest = vi.fn(() => frame.promise);
  const request = (method: string) => {
    if (method === "logbook.status") {
      return status;
    }
    return method === "logbook.frame" ? frameRequest() : timeline;
  };
  const view = mountLogbook(request);
  await waitForSolid(() =>
    expect(view.container.querySelectorAll(".logbook-card__header")).toHaveLength(2),
  );
  const headers = view.container.querySelectorAll<HTMLButtonElement>(".logbook-card__header");
  headers[0]!.click();
  headers[1]!.click();
  await waitForSolid(() =>
    expect(view.container.querySelectorAll(".logbook-card__keyframe--loading")).toHaveLength(2),
  );
  expect(frameRequest).toHaveBeenCalledTimes(1);
  frame.resolve({ format: "png", base64: "synthetic-preview" });
  await waitForSolid(() =>
    expect(view.container.querySelectorAll("img.logbook-card__keyframe")).toHaveLength(2),
  );
  expect(
    Array.from(view.container.querySelectorAll("img.logbook-card__keyframe"), (img) =>
      img.getAttribute("src"),
    ),
  ).toEqual(Array(2).fill("data:image/png;base64,synthetic-preview"));
  expect(view.container.querySelectorAll(".logbook-card__keyframe--loading")).toHaveLength(0);
});

it("keeps the side editor usable while a delayed timeline fails and retries", async () => {
  const pending = createDeferred<LogbookTimelinePayload>();
  let retry = false;
  const request = vi.fn((method: string) =>
    method === "logbook.status" ? status : retry ? empty : pending.promise,
  );
  const view = mountLogbook(request);
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
  const timeline = logbookTimeline(day, [{ title: "Synthetic work", detail: "Retained detail" }]);
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
  const view = mountLogbook(request);
  await waitForSolid(() =>
    expect(view.container.querySelector(".logbook-card__header")).not.toBeNull(),
  );
  const card = view.container.querySelector<HTMLButtonElement>(".logbook-card__header")!;
  const detail = () => view.container.querySelector(".logbook-card__detail")?.textContent;
  card.click();
  flush();
  view.container.querySelector<HTMLButtonElement>(".logbook__actions button:last-child")!.click();
  flush();
  expect(view.container.querySelector(".logbook-card__header")).toBe(card);
  expect(detail()).toContain("Retained detail");
  refresh.resolve({ ...timeline, cards: [{ ...timeline.cards[0]!, title: "Updated work" }] });
  await waitForSolid(() => expect(card.textContent).toContain("Updated work"));
  expect(view.container.querySelector(".logbook-card__header")).toBe(card);
  expect(detail()).toContain("Retained detail");
});
