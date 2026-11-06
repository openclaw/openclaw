import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { chatHistoryRequestParams } from "../pages/chat/chat-history-request-params.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import {
  sampleHistoryAnchor,
  type AnchorWindow,
} from "./chat-history-pagination-probe.test-support.ts";

// Hold the actual foreground owner before either a staged take or a wire read.
export async function holdHistoryPacketEntry(pane: Locator, direction: "older" | "newer") {
  const gate = await pane.evaluateHandle(
    (element: HTMLElement, heldDirection: "older" | "newer") => {
      type Args = [unknown, "older" | "newer", boolean, AbortSignal, () => boolean];
      type Owner = {
        state: {
          chatHistoryPagination: {
            olderCursor?: string;
            newerCursor?: string;
            needsBoundary?: boolean;
            needsNewerBoundary?: boolean;
          };
        };
        stagedHistory: { page: unknown; load: unknown };
        loadNativeHistoryPackets: (...args: Args) => Promise<boolean>;
      };
      const scope = window as Window & {
        openclawPaneRuntimeForTest?: (element: HTMLElement) => object | undefined;
      };
      const runtime = scope.openclawPaneRuntimeForTest?.(element);
      if (!runtime || typeof Reflect.get(runtime, "loadNativeHistoryPackets") !== "function") {
        throw new Error("History entry gate requires the mounted pane runtime test adapter");
      }
      const owner = runtime as Owner;
      const state = owner.state;
      const original = owner.loadNativeHistoryPackets;
      const descriptor = Object.getOwnPropertyDescriptor(owner, "loadNativeHistoryPackets");
      let captured: { args: Args; release: () => void } | undefined;
      let intent: { signal: AbortSignal; owns: () => boolean } | undefined;
      let armed = true;
      const { promise: released, resolve: release } = Promise.withResolvers<void>();
      const { promise: completed, resolve: complete } = Promise.withResolvers<void>();
      const wrapper = async function (this: Owner, ...args: Args) {
        if (armed && this === owner && args[0] === state && args[1] === heldDirection && args[2]) {
          armed = false;
          captured = { args, release };
          intent = { signal: args[3], owns: args[4] };
          try {
            await released;
            captured = undefined;
            return await Reflect.apply(original, this, args);
          } finally {
            intent = undefined;
            complete();
          }
        }
        return Reflect.apply(original, this, args);
      };
      Object.defineProperty(owner, "loadNativeHistoryPackets", {
        configurable: true,
        writable: true,
        value: wrapper,
      });
      const current = () =>
        intent !== undefined && owner.state === state && !intent.signal.aborted && intent.owns();
      return {
        held: () => captured !== undefined,
        current,
        coldCursor: () => {
          if (!captured || !current() || owner.stagedHistory.page || owner.stagedHistory.load) {
            throw new Error("Initial reader calibration requires an actual cold foreground entry");
          }
          const pagination = state.chatHistoryPagination;
          const boundary =
            heldDirection === "older" ? pagination.needsBoundary : pagination.needsNewerBoundary;
          const cursor =
            heldDirection === "older" ? pagination.olderCursor : pagination.newerCursor;
          if (boundary || typeof cursor !== "string" || !cursor) {
            throw new Error("Initial reader calibration requires the actual foreground cursor");
          }
          return cursor;
        },
        release: () => {
          if (!captured || !current()) {
            throw new Error("Held history intent retired before the reader sample completed");
          }
          captured!.release();
        },
        dispose: async () => {
          const entered = !armed;
          armed = false;
          release();
          if (owner.loadNativeHistoryPackets !== wrapper) {
            throw new Error("History entry gate lost ownership of its method wrapper");
          }
          if (descriptor) {
            Object.defineProperty(owner, "loadNativeHistoryPackets", descriptor);
          } else {
            Reflect.deleteProperty(owner, "loadNativeHistoryPackets");
          }
          if (entered) {
            await completed;
          }
        },
      };
    },
    direction,
  );
  return {
    wait: () => expect.poll(() => gate.evaluate((entry) => entry.held())).toBe(true),
    assertCurrent: async () => expect(await gate.evaluate((entry) => entry.current())).toBe(true),
    coldCursor: () => gate.evaluate((entry) => entry.coldCursor()),
    release: () => gate.evaluate((entry) => entry.release()),
    dispose: async () => {
      try {
        await gate.evaluate((entry) => entry.dispose());
      } finally {
        await gate.dispose();
      }
    },
  };
}

// Keep real Gateway bytes/cursors intact; only delivery waits for settled reader input.
export async function installHistoryResponseGate(page: Page, sessionKey: string) {
  let armed = false;
  let pendingRequests = 0;
  let coldRequest: { id?: string } | undefined;
  const replies: Array<{ deliver: () => void; id: string; cursor: string; sha256: string }> = [];
  const released: Array<{ id: string; cursor: string; sha256: string }> = [];
  await page.routeWebSocket(/\/.*$/u, (socket) => {
    const server = socket.connectToServer();
    const requests = new Map<string, string>();
    socket.onMessage((message) => {
      const frame: unknown = JSON.parse(message.toString());
      if (
        isRecord(frame) &&
        frame.method === "chat.history" &&
        typeof frame.id === "string" &&
        isRecord(frame.params) &&
        frame.params.sessionKey === sessionKey &&
        typeof frame.params.cursor === "string"
      ) {
        pendingRequests++;
        requests.set(frame.id, frame.params.cursor);
        if (coldRequest && !coldRequest.id) {
          coldRequest.id = frame.id;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame: unknown = JSON.parse(message.toString());
      const id = isRecord(frame) && typeof frame.id === "string" ? frame.id : undefined;
      const cursor = id && requests.get(id);
      if (id && cursor) {
        pendingRequests--;
      }
      if (id && cursor && armed) {
        requests.delete(id);
        replies.push({
          id,
          cursor,
          sha256: createHash("sha256").update(message).digest("hex"),
          deliver: () => socket.send(message),
        });
      } else {
        if (id) {
          requests.delete(id);
        }
        socket.send(message);
      }
    });
  });
  return {
    arm: () => {
      armed = true;
    },
    // The first calibration must follow request sizing, while its exact reply is held.
    waitForColdReply: async (cursor: string, releaseEntry: () => Promise<void>) => {
      expect(armed && !pendingRequests && !replies.length && !released.length && !coldRequest).toBe(
        true,
      );
      const request: { id?: string } = {};
      coldRequest = request;
      try {
        await releaseEntry();
        await expect
          .poll(() => request.id !== undefined && replies.some((reply) => reply.id === request.id))
          .toBe(true);
        expect(replies.find((reply) => reply.id === request.id)?.cursor).toBe(cursor);
      } finally {
        coldRequest = undefined;
      }
    },
    disarm: () => {
      armed = false;
      for (const reply of replies.splice(0)) {
        reply.deliver();
      }
    },
    // Keep speculation armed while one foreground claim releases its serial
    // members. A published window wins over a newly held speculative reply.
    releaseAdmission: async (published: () => Promise<boolean>, maxPackets: number) => {
      const first = released.length;
      for (;;) {
        let status = "waiting";
        await expect
          .poll(async () => {
            status = (await published()) ? "published" : replies.length ? "reply" : "waiting";
            return status;
          })
          .not.toBe("waiting");
        if (status === "published") {
          return released.length - first;
        }
        if (released.length - first >= maxPackets) {
          throw new Error("Foreground history chain exceeded its packet bound");
        }
        const reply = replies.shift()!;
        reply.deliver();
        released.push({ id: reply.id, cursor: reply.cursor, sha256: reply.sha256 });
      }
    },
    released,
  };
}

export async function sampleControlledHistoryAdmission(
  page: Page,
  thread: Locator,
  options: {
    direction: string;
    residentEdge: number;
    readResident: () => Promise<number[]>;
    readerCalibration: boolean;
  },
) {
  await waitForChatScrollIdle(page);
  const resident = await options.readResident();
  expect(
    options.direction === "older" ? resident[0] : resident.at(-1),
    "held response has not published before the reader sample",
  ).toBe(options.residentEdge);
  // A virtualizer's estimated end need not render the resident edge.
  // Sample the actual visible reader, matching the prepend anchor owner.
  const source = await thread.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    for (const bubble of element.querySelectorAll(".chat-bubble")) {
      const rect = bubble.getBoundingClientRect();
      const match = bubble.textContent?.match(/Synthetic loading proof message (\d+)\./u);
      if (match && rect.bottom > viewport.top && rect.top < viewport.bottom) {
        return Number(match[1]);
      }
    }
    return null;
  });
  if (source === null) {
    throw new Error("No rendered reader intersects the transcript viewport");
  }
  expect(resident).toContain(source);
  const bubble = thread.locator(".chat-bubble").filter({
    hasText: `Synthetic loading proof message ${source}.`,
  });
  await bubble.waitFor();
  const probe = await sampleHistoryAnchor(bubble);
  let stopped = false;
  const stopProbe = async () => {
    try {
      return await probe.evaluate((stop) => stop());
    } finally {
      stopped = true;
      await probe.dispose();
    }
  };
  const cancel = async () => {
    if (!stopped) {
      await stopProbe();
    }
  };
  let readerMotion = 0;
  try {
    if (options.readerCalibration) {
      // No response is admitted during this phase. Normalize observed reader motion
      // only, then freeze that correction before admission can produce scroll writes.
      const motion = await bubble.evaluateHandle((element) => {
        const scrollElement = element.closest<HTMLElement>(".chat-thread")!;
        const pane = element.closest<HTMLElement>("openclaw-chat-pane") as HTMLElement & {
          state: {
            chatIsProgrammaticScroll: () => boolean;
            chatIsMaintenanceScroll: () => boolean;
          };
        };
        let prior = scrollElement.scrollTop;
        let invalid = false;
        let delta = 0;
        const onScroll = () => {
          invalid ||= pane.state.chatIsProgrammaticScroll() || pane.state.chatIsMaintenanceScroll();
          const consumed = scrollElement.scrollTop - prior;
          prior = scrollElement.scrollTop;
          delta += consumed;
          (window as AnchorWindow).prependFrames.readerDelta += consumed;
        };
        scrollElement.addEventListener("scroll", onScroll);
        return () => {
          scrollElement.removeEventListener("scroll", onScroll);
          return { invalid, delta };
        };
      });
      try {
        await page.mouse.wheel(0, 40);
        await waitForChatScrollIdle(page);
        const result = await motion.evaluate((stop) => stop());
        expect(result.invalid, "calibration contains reader motion only").toBe(false);
        expect(result.delta).toBeGreaterThan(0);
        readerMotion = result.delta;
      } finally {
        try {
          await motion.evaluate((stop) => stop());
        } finally {
          await motion.dispose();
        }
      }
    }
  } catch (error) {
    await cancel();
    throw error;
  }
  const finish = async () => {
    await waitForChatScrollIdle(page);
    const positions = await stopProbe();
    const initial = positions[0];
    expect(initial).not.toBeNull();
    expect(positions.length).toBeGreaterThan(1);
    const maxDrift = Math.max(
      ...positions.map((top) => (top === null ? Infinity : Math.abs(top - initial!))),
    );
    return { positions, frames: positions.length, maxDrift, readerMotion };
  };
  return { source, bubble, finish, cancel };
}

export async function detectNonInputHistoryShift(page: Page, bubble: Locator) {
  const probe = await sampleHistoryAnchor(bubble);
  try {
    const before = await bubble.evaluate((element: HTMLElement) => {
      const prior = element.style.transform;
      element.style.transform = "translateY(12px)";
      return prior;
    });
    try {
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
    } finally {
      await bubble.evaluate((element: HTMLElement, prior) => {
        element.style.transform = prior;
      }, before);
    }
    const positions = await probe.evaluate((stop) => stop());
    expect(positions.every((top) => top !== null)).toBe(true);
    const maxDrift = Math.max(...positions.map((top) => Math.abs(top! - positions[0]!)));
    expect(maxDrift, "non-input shift must fail the placement oracle").toBeGreaterThan(2);
    return { positions, maxDrift };
  } finally {
    try {
      await probe.evaluate((stop) => stop());
    } finally {
      await probe.dispose();
    }
  }
}

type HistoryPacketMetric = {
  requestId: string;
  sentMs?: number;
  receivedMs?: number;
  historyOk?: boolean;
  historyKind?: "window" | "delta" | "reset";
  cursor?: string;
  limit?: number;
  maxBytes?: number;
  olderCursor?: string;
  newerCursor?: string;
  sourceNumbers?: number[];
};

export function createHistoryAdmissionRecorder(read: () => HistoryPacketMetric[]) {
  // Both comparison arms expose this request owner; its constants may remain private.
  const { limit: CHAT_HISTORY_REQUEST_LIMIT, maxBytes: CHAT_HISTORY_REQUEST_MAX_BYTES } =
    chatHistoryRequestParams("chat.history", "history-proof", undefined);
  const admissionReceipts: Array<{
    direction: string;
    admitted: string[];
    refined: string[];
    staged: string[];
    retired: string[];
  }> = [];
  let seenRequests = 0;
  let remainder: { direction: string; metric: HistoryPacketMetric } | undefined;
  const recordAdmission = (direction: string, retained: number[]) => {
    const history = read();
    const retired =
      remainder && remainder.direction !== direction ? [remainder.metric.requestId] : [];
    const chain = [
      ...(remainder?.direction === direction ? [remainder.metric] : []),
      ...history.slice(seenRequests),
    ];
    seenRequests = history.length;
    const sources = new Set(retained);
    const refined = chain.filter((metric, index) => {
      const next = chain[index + 1];
      if (!next || metric.cursor !== next.cursor) {
        return false;
      }
      for (const reply of [metric, next]) {
        expect(reply.historyOk).toBe(true);
        expect(reply.historyKind).toBe("window");
        expect(Number.isFinite(reply.sentMs)).toBe(true);
        expect(Number.isFinite(reply.receivedMs)).toBe(true);
        expect(reply.receivedMs!).toBeGreaterThanOrEqual(reply.sentMs!);
        expect(Number.isInteger(reply.limit)).toBe(true);
        expect(Number.isInteger(reply.maxBytes)).toBe(true);
      }
      expect(next.sentMs!).toBeGreaterThanOrEqual(metric.receivedMs!);
      // Broad-issued replies can still be certified small packets and refine to
      // one source. Changed custody may instead require a smaller adaptive read.
      const broad =
        metric.limit! > CHAT_HISTORY_REQUEST_LIMIT ||
        metric.maxBytes! > CHAT_HISTORY_REQUEST_MAX_BYTES;
      const canonical =
        (next.limit === 1 || (broad && next.limit === CHAT_HISTORY_REQUEST_LIMIT)) &&
        next.maxBytes === CHAT_HISTORY_REQUEST_MAX_BYTES;
      const adaptive =
        next.limit! > CHAT_HISTORY_REQUEST_LIMIT && next.maxBytes! > CHAT_HISTORY_REQUEST_MAX_BYTES;
      expect(canonical || adaptive).toBe(true);
      expect(next.limit!).toBeLessThanOrEqual(metric.limit!);
      expect(next.maxBytes!).toBeLessThanOrEqual(metric.maxBytes!);
      expect(next.limit! < metric.limit! || next.maxBytes! < metric.maxBytes!).toBe(true);
      return true;
    });
    const admitted = chain.filter(
      (metric) =>
        !refined.includes(metric) &&
        metric.sourceNumbers?.length &&
        metric.sourceNumbers.every((source) => sources.has(source)),
    );
    const staged = chain.filter(
      (metric) => !admitted.includes(metric) && !refined.includes(metric),
    );
    // Eight foreground attempts include discarded broad reads and their
    // narrower retry. Only one unadmitted successor may remain staged.
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.length).toBeLessThanOrEqual(8);
    expect(staged.length).toBeLessThanOrEqual(1);
    expect(admitted.length + refined.length).toBeLessThanOrEqual(8);
    expect(chain.length).toBeLessThanOrEqual(9);
    for (let index = 1; index < chain.length; index++) {
      const previous = chain[index - 1]!;
      expect(previous.receivedMs).toBeDefined();
      expect(chain[index]!.cursor).toBe(
        refined.includes(previous)
          ? previous.cursor
          : direction === "older"
            ? previous.olderCursor
            : previous.newerCursor,
      );
    }
    remainder = staged[0] ? { direction, metric: staged[0] } : undefined;
    admissionReceipts.push({
      direction,
      admitted: admitted.map((metric) => metric.requestId),
      refined: refined.map((metric) => metric.requestId),
      staged: staged.map((metric) => metric.requestId),
      retired,
    });
  };
  return { receipts: admissionReceipts, record: recordAdmission };
}
