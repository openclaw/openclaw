import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { localDayKey } from "./logbook-state.ts";
import { Logbook } from "./logbook-view.tsx";

const day = localDayKey();
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
  todayCards: 1,
  timeZone: "UTC",
};
const timeline = {
  day,
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
      keyframeId: 3,
    },
  ],
  stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
};

afterEach(cleanupSolid);

async function mountFrame(frame: Promise<{ base64: string; format: string }>) {
  const request = vi.fn((method: string) => {
    switch (method) {
      case "logbook.status":
        return status;
      case "logbook.timeline":
        return timeline;
      case "logbook.frame":
        return frame;
      default:
        throw new Error(`Unexpected Logbook request: ${method}`);
    }
  });
  const view = mountSolid(() => <Logbook initialClient={createTestGatewayClient(request)} />);
  await waitForSolid(() =>
    expect(view.container.querySelector(".logbook-card__header")).not.toBeNull(),
  );
  const card = view.container.querySelector<HTMLButtonElement>(".logbook-card__header")!;
  card.click();
  await waitForSolid(() =>
    expect(view.container.querySelector(".logbook-card__keyframe--loading")).not.toBeNull(),
  );
  return { ...view, request, card };
}

it("keeps an expanded card usable when reopening a held keyframe read", async () => {
  const frame = createDeferred<{ base64: string; format: string }>();
  const view = await mountFrame(frame.promise);
  view.card.click();
  flush();
  view.card.click();
  flush();
  expect(view.container.querySelector(".logbook-card__keyframe--loading")).not.toBeNull();
  expect(view.container.querySelector(".logbook-card__detail")?.textContent).toBe(
    "Retained detail",
  );
  frame.resolve({ base64: "AA==", format: "png" });
  await waitForSolid(() =>
    expect(view.container.querySelector("img.logbook-card__keyframe")?.getAttribute("src")).toBe(
      "data:image/png;base64,AA==",
    ),
  );
  expect(view.container.querySelector(".logbook-card__header")).toBe(view.card);
  expect(view.request.mock.calls.filter(([method]) => method === "logbook.frame")).toHaveLength(1);
});

it("retires a missing keyframe without retrying when its card reopens", async () => {
  const frame = createDeferred<{ base64: string; format: string }>();
  const view = await mountFrame(frame.promise);
  frame.reject(new Error("Keyframe was pruned"));
  await waitForSolid(() =>
    expect(view.container.querySelector(".logbook-card__keyframe")).toBeNull(),
  );
  view.card.click();
  flush();
  view.card.click();
  flush();
  expect(view.container.querySelector(".logbook-card__keyframe")).toBeNull();
  expect(view.container.querySelector(".logbook-card__detail")?.textContent).toBe(
    "Retained detail",
  );
  expect(view.request.mock.calls.filter(([method]) => method === "logbook.frame")).toHaveLength(1);
});
