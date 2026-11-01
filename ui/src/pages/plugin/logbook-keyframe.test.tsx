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

function reopen(card: HTMLButtonElement) {
  card.click();
  flush();
  card.click();
  flush();
}

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
  const query = (selector: string) => view.container.querySelector(selector);
  const frameRequests = () => request.mock.calls.filter(([method]) => method === "logbook.frame");
  await waitForSolid(() => expect(query(".logbook-card__header")).not.toBeNull());
  const card = view.container.querySelector<HTMLButtonElement>(".logbook-card__header")!;
  card.click();
  await waitForSolid(() => expect(query(".logbook-card__keyframe--loading")).not.toBeNull());
  return { ...view, query, frameRequests, card };
}

it("keeps an expanded card usable when reopening a held keyframe read", async () => {
  const frame = createDeferred<Frame>();
  const view = await mountFrame(frame.promise);
  reopen(view.card);
  expect(view.query(".logbook-card__keyframe--loading")).not.toBeNull();
  expect(view.query(".logbook-card__detail")?.textContent).toBe("Retained detail");
  frame.resolve({ base64: "AA==", format: "png" });
  await waitForSolid(() =>
    expect(view.query("img.logbook-card__keyframe")?.getAttribute("src")).toBe(
      "data:image/png;base64,AA==",
    ),
  );
  expect(view.query(".logbook-card__header")).toBe(view.card);
  expect(view.frameRequests()).toHaveLength(1);
});

it("retires a missing keyframe without retrying when its card reopens", async () => {
  const frame = createDeferred<Frame>();
  const view = await mountFrame(frame.promise);
  frame.reject(new Error("Keyframe was pruned"));
  await waitForSolid(() => expect(view.query(".logbook-card__keyframe")).toBeNull());
  reopen(view.card);
  expect(view.query(".logbook-card__keyframe")).toBeNull();
  expect(view.query(".logbook-card__detail")?.textContent).toBe("Retained detail");
  expect(view.frameRequests()).toHaveLength(1);
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
  },
);

it("retains expanded images when the bounded cache evicts their source", async () => {
  const frame = createDeferred<Frame>();
  const view = await mountFrame(frame.promise, 49);
  const imageCount = () => view.container.querySelectorAll("img.logbook-card__keyframe").length;
  const headers = view.container.querySelectorAll<HTMLButtonElement>(".logbook-card__header");
  for (const header of Array.from(headers).slice(1)) {
    header.click();
  }
  flush();
  await waitForSolid(() => expect(view.frameRequests()).toHaveLength(49));
  frame.resolve({ base64: "AA==", format: "png" });
  await waitForSolid(() => expect(imageCount()).toBe(49));
  expect(view.frameRequests()).toHaveLength(49);
  reopen(view.card);
  await waitForSolid(() => expect(imageCount()).toBe(49));
  expect(view.frameRequests()).toHaveLength(50);
});
