/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-companion-lifecycle.test/"} */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { ChatSessionCompanionThreads } from "./chat-session-companion.ts";

const companionThreads = (pane: TestChatPane) =>
  (pane as TestChatPane & { sessionCompanionThreads: ChatSessionCompanionThreads })
    .sessionCompanionThreads;

it.each(["reconnect", "replacement"])(
  "preserves only the current client's threads during %s",
  async (change) => {
    const request = vi.fn(() => {
      throw new Error("Unexpected request while disconnected");
    });
    const client = () => ({ request }) as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client: client() });
    const threads = companionThreads(pane);
    const current = "agent:main:current";
    const other = "agent:main:other";
    const question = "current question";
    const earlier = { question: "Earlier question", answer: "Earlier answer", ts: 1 };
    await threads.hydrate(current, async () => ({ exchanges: [earlier] }), "main");
    const answer = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit(current, question, () => answer.promise, "main");
    threads.setDraft(other, "other draft", "main");
    const replacing = change === "replacement";
    // Transport rejection precedes the reconnecting snapshot, but settles on the next microtask.
    if (!replacing) {
      answer.reject(new Error("gateway closed"));
    }
    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: replacing ? client() : pane.context.gateway.snapshot.client,
      phase: "reconnecting",
      hello: null,
    });
    const turns = () => threads.view(current, "main").turns;
    expect(threads.view(other, "main").draft).toBe(replacing ? "" : "other draft");
    expect(turns()).toMatchObject(
      replacing
        ? []
        : [
            { ...earlier, status: "answered" },
            { question, status: "pending" },
          ],
    );
    if (replacing) {
      answer.resolve({ answer: "late answer", ts: 3 });
    }
    await pending;
    expect(turns()).toMatchObject(
      replacing
        ? []
        : [
            { ...earlier, status: "answered" },
            { question, status: "failed", hint: "unavailable", retryable: true },
          ],
    );
  },
);
