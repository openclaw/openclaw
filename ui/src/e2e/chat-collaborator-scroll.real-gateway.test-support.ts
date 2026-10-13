import { createServer, type ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { Page } from "playwright";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";

// Only inference is synthetic. Gateway traffic, custody, persistence and
// renderer reconciliation are never intercepted or replaced.
export async function startScrollInferenceFixture() {
  type Turn = {
    index: number;
    accept: (response: ServerResponse) => void;
    append: (delta: string) => Promise<void>;
    finish: () => Promise<void>;
  };
  const turns: Turn[] = [];
  const responses = new Set<ServerResponse>();
  const handlers = new Set<Promise<void>>();
  const failures: string[] = [];
  let requests = 0;
  function plan(): Turn {
    const received = createDeferred<ServerResponse>();
    const index = turns.length + 1;
    let response: ServerResponse | undefined;
    let text = "";
    const messageId = "scroll-message-" + index;
    const emit = (event: Record<string, unknown>) => {
      if (!response || response.destroyed || response.writableEnded) {
        throw new Error("Inference turn is not writable: " + index);
      }
      response.write("data: " + JSON.stringify(event) + "\n\n");
    };
    const turn = {
      index,
      accept(incoming: ServerResponse) {
        response = incoming;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        emit({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        });
        received.resolve(incoming);
      },
      async append(delta: string) {
        await received.promise;
        text += delta;
        emit({
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta,
        });
      },
      async finish() {
        await received.promise;
        const message = {
          type: "message",
          id: messageId,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        emit({
          type: "response.output_text.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text,
        });
        emit({ type: "response.output_item.done", output_index: 0, item: message });
        emit({
          type: "response.completed",
          response: {
            id: "scroll-response-" + index,
            status: "completed",
            output: [message],
            usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
          },
        });
        response!.end("data: [DONE]\n\n");
      },
    };
    turns.push(turn);
    return turn;
  }
  const server = createServer((request, response) => {
    responses.add(response);
    response.once("close", () => responses.delete(response));
    const handler = (async () => {
      await finished(request.resume());
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const turn = turns[requests++];
      if (!turn) {
        throw new Error("Unplanned inference request " + requests);
      }
      turn.accept(response);
    })();
    handlers.add(handler);
    void handler.then(
      () => handlers.delete(handler),
      (error: unknown) => {
        failures.push(String(error));
        response.destroy();
        handlers.delete(handler);
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Inference fixture did not bind loopback");
  }
  return {
    port: address.port,
    plan,
    requests: () => requests,
    failures,
    async close() {
      for (const response of responses) {
        response.destroy();
      }
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await Promise.all(handlers);
      await closed;
    },
  };
}

type AssistantVisibilityFailure = { at: number; text: string; opacity: string; transform: string };
declare global {
  interface Window {
    assistantVisibilityProof?: { failures: AssistantVisibilityFailure[]; stop: () => void };
    replyPresenceProof?: {
      missing: Array<{ at: number; runId: string | null; streamLength: number | null }>;
      stop: () => void;
    };
  }
}

export async function startAssistantVisibilityProbe(page: Page) {
  await page.evaluate(() => {
    const failures: AssistantVisibilityFailure[] = [];
    let frame = 0;
    const sample = () => {
      for (const bubble of document.querySelectorAll<HTMLElement>(
        ".chat-pane-cache__pane--active .chat-group.assistant .chat-bubble",
      )) {
        if (!bubble.textContent?.trim()) {
          continue;
        }
        const style = getComputedStyle(bubble);
        if (style.opacity !== "1" || style.transform !== "none") {
          failures.push({
            at: performance.now(),
            text: bubble.textContent.slice(0, 100),
            opacity: style.opacity,
            transform: style.transform,
          });
        }
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    window.assistantVisibilityProof = { failures, stop: () => cancelAnimationFrame(frame) };
  });
  return async () =>
    await page.evaluate(() => {
      const probe = window.assistantVisibilityProof;
      if (!probe) {
        throw new Error("Assistant visibility probe was not started");
      }
      probe.stop();
      return probe.failures;
    });
}

export async function watchExistingReply(page: Page, prefix: string) {
  await page
    .locator(".chat-text p")
    .filter({ hasText: prefix })
    .first()
    .waitFor({ state: "attached" });
  await page.evaluate((textPrefix) => {
    const thread = document.querySelector<HTMLElement>(
      ".chat-pane-cache__pane--active .chat-thread",
    );
    if (!thread) {
      throw new Error("Reply-presence probe has no transcript");
    }
    const present = () =>
      [...thread.querySelectorAll(".chat-text p")].some((paragraph) =>
        paragraph.textContent?.startsWith(textPrefix),
      );
    if (!present()) {
      throw new Error("Expected reply was not present before submission");
    }
    const missing: Array<{ at: number; runId: string | null; streamLength: number | null }> = [];
    let frame = 0;
    const sample = () => {
      if (!present()) {
        const state = thread.closest<HTMLElement & { state?: ChatPageHost }>(
          "openclaw-chat-pane",
        )?.state;
        missing.push({
          at: performance.now(),
          runId: state?.chatRunId ?? null,
          streamLength: state?.chatStream?.length ?? null,
        });
      }
      frame = requestAnimationFrame(sample);
    };
    window.replyPresenceProof = { missing, stop: () => cancelAnimationFrame(frame) };
    frame = requestAnimationFrame(sample);
  }, prefix);
  return async () =>
    await page.evaluate(() => {
      const probe = window.replyPresenceProof;
      if (!probe) {
        throw new Error("Reply-presence probe was not started");
      }
      probe.stop();
      return probe.missing;
    });
}

type ScrollSample = {
  top: number;
  anchor: number | null;
  distance: number;
  messageKey?: string;
  rowKey?: string;
  policy?: {
    locked: boolean;
    initialized: boolean;
    runId: string | null;
    streamLength: number | null;
  };
  rows: Array<{ key?: string; height: number }>;
};
type ScrollProbeElement = HTMLElement & {
  scrollProof: { samples: ScrollSample[]; stop: () => void };
};
export async function startScrollProbe(page: Page) {
  return page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    const paragraph = [...element.querySelectorAll<HTMLElement>(".chat-text p")].find(
      (candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          rect.top >= viewport.top + 1 &&
          rect.bottom <= viewport.bottom - 1 &&
          candidate.textContent?.trim()
        );
      },
    );
    if (!paragraph) {
      throw new Error("No fully visible real transcript reading anchor");
    }
    const anchorText = paragraph.textContent!.trim();
    const sample = (): ScrollSample => {
      const anchor = [...element.querySelectorAll<HTMLElement>(".chat-text p")].find(
        (candidate) => candidate.textContent?.trim() === anchorText,
      );
      const pane = element.closest<HTMLElement & { state?: ChatPageHost }>("openclaw-chat-pane");
      const state = pane?.state;
      return {
        messageKey: anchor?.closest<HTMLElement>(".chat-bubble")?.dataset.messageId,
        rowKey: anchor?.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey,
        policy: state
          ? {
              locked: state.chatFollowLocked,
              initialized: state.chatHasAutoScrolled,
              runId: state.chatRunId,
              streamLength: state.chatStream?.length ?? null,
            }
          : undefined,
        rows: [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].map((row) => ({
          key: row.dataset.virtualRowKey,
          height: row.offsetHeight,
        })),
        top: element.scrollTop,
        distance: element.scrollHeight - element.clientHeight - element.scrollTop,
        anchor: anchor
          ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
          : null,
      };
    };
    const before = sample();
    const samples = [before];
    let frame = 0;
    const tick = () => {
      samples.push(sample());
      frame = requestAnimationFrame(tick);
    };
    (element as ScrollProbeElement).scrollProof = {
      samples,
      stop: () => cancelAnimationFrame(frame),
    };
    frame = requestAnimationFrame(tick);
    return { ...before, anchorText };
  });
}
export async function readScrollProbe(page: Page, stop = false) {
  return page
    .locator(".chat-pane-cache__pane--active .chat-thread")
    .evaluate((element, shouldStop) => {
      const probe = (element as ScrollProbeElement).scrollProof;
      if (shouldStop) {
        probe.stop();
      }
      return probe.samples;
    }, stop);
}
