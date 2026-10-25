import { createRoot } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createLogbook, localDayKey } from "./logbook-state.ts";
import { Logbook } from "./logbook-view.tsx";
import { logbookStatus, logbookTimeline } from "./logbook.test-support.ts";

type Frame = { base64: string; format: string };
const day = localDayKey();
const neverRetired = new Promise<void>(() => {});
const disposals: Array<() => void> = [];

afterEach(() => {
  cleanupSolid();
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
});

function frameModel(frame: Promise<Frame>) {
  const request = vi.fn(() => frame);
  const model = createRoot((dispose) => {
    disposals.push(dispose);
    return Object.assign(createLogbook(createTestGatewayClient(request)), { dispose });
  });
  flush();
  return { model, request };
}

async function mountFrame(frame: Promise<Frame>, count = 1) {
  const request = vi.fn((method: string) => {
    switch (method) {
      case "logbook.status":
        return logbookStatus(day);
      case "logbook.timeline":
        return logbookTimeline(
          day,
          Array.from({ length: count }, (_, index) => ({
            id: index + 1,
            title: "Synthetic work",
            detail: "Retained detail",
            keyframeId: index + 3,
          })),
        );
      case "logbook.frame":
        return frame;
      default:
        throw new Error(`Unexpected Logbook request: ${method}`);
    }
  });
  const view = mountSolid(() => (
    <Logbook initialClient={createTestGatewayClient(request)} getRetired={() => neverRetired} />
  ));
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

it("keeps duplicate frame readers pending until their shared request settles", async () => {
  const frame = createDeferred<Frame>();
  const { model, request } = frameModel(frame.promise);
  const first = model.loadFrame(3);
  const second = model.loadFrame(3);
  let joinedSettled = false;
  void second.then(() => {
    joinedSettled = true;
  });
  await Promise.resolve();
  expect(joinedSettled).toBe(false);
  frame.resolve({ base64: "AA==", format: "png" });
  expect(await Promise.all([first, second])).toEqual([
    "data:image/png;base64,AA==",
    "data:image/png;base64,AA==",
  ]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("keeps an expanded card usable when reopening a held keyframe read", async () => {
  const frame = createDeferred<Frame>();
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
  const frame = createDeferred<Frame>();
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

it.each(["resolve", "reject"] as const)(
  "discards a retired connection's frame %s without affecting the replacement",
  async (outcome) => {
    const oldFrame = createDeferred<Frame>();
    const old = frameModel(oldFrame.promise);
    const oldState = old.model.state;
    const oldRead = old.model.loadFrame(3);
    old.model.dispose();
    const frame = createDeferred<Frame>();
    const current = frameModel(frame.promise);
    const read = current.model.loadFrame(3);
    if (outcome === "resolve") {
      oldFrame.resolve({ base64: "OLD=", format: "png" });
    } else {
      oldFrame.reject(new Error("Old frame was pruned"));
    }
    expect(await oldRead).toBeUndefined();
    expect(oldState.framePreviews.size).toBe(0);
    expect(oldState.framePreviewFailed.size).toBe(0);
    expect(current.model.state.framePreviews.size).toBe(0);
    expect(current.model.state.framePreviewFailed.size).toBe(0);
    frame.resolve({ base64: "NEW=", format: "png" });
    expect(await read).toBe("data:image/png;base64,NEW=");
    expect(current.request).toHaveBeenCalledTimes(1);
  },
);

it("retains expanded images when the bounded cache evicts their source", async () => {
  const frame = createDeferred<Frame>();
  const view = await mountFrame(frame.promise, 49);
  const headers = view.container.querySelectorAll<HTMLButtonElement>(".logbook-card__header");
  for (const header of Array.from(headers).slice(1)) {
    header.click();
  }
  flush();
  await waitForSolid(() =>
    expect(view.request.mock.calls.filter(([method]) => method === "logbook.frame")).toHaveLength(
      49,
    ),
  );
  frame.resolve({ base64: "AA==", format: "png" });
  await waitForSolid(() =>
    expect(view.container.querySelectorAll("img.logbook-card__keyframe")).toHaveLength(49),
  );
  expect(view.request.mock.calls.filter(([method]) => method === "logbook.frame")).toHaveLength(49);
  view.card.click();
  flush();
  view.card.click();
  await waitForSolid(() =>
    expect(view.container.querySelectorAll("img.logbook-card__keyframe")).toHaveLength(49),
  );
  expect(view.request.mock.calls.filter(([method]) => method === "logbook.frame")).toHaveLength(50);
});
