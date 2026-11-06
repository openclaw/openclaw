// Doctor channel ingress tests cover dead-letter visibility and recovery guidance.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { noteChannelIngressDeadLetters } from "./doctor-channel-ingress.js";

describe("noteChannelIngressDeadLetters", () => {
  afterEach(() => vi.restoreAllMocks());
  it("mentions affected channel accounts and the inspection command", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-doctor-ingress-" },
      async ({ stateDir }) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "telegram",
          accountId: "ops",
          stateDir,
        });
        const noteFn = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
        for (const reason of ["queue-cap-old", "queue-cap-new"]) {
          await queue.enqueue(reason, { text: "intentional drop" });
          await queue.fail(reason, { reason, failedAt: 10 });
        }
        await noteChannelIngressDeadLetters();
        expect(noteFn).not.toHaveBeenCalled();
        await queue.enqueue("event-1", { text: "recover me" });
        await queue.fail("event-1", { reason: "handler-error", failedAt: 20 });
        await noteChannelIngressDeadLetters();

        expect(noteFn).toHaveBeenCalledWith(
          expect.stringContaining("telegram/ops: 1 dead-lettered ingress event"),
          "Channel ingress",
        );
        expect(noteFn.mock.calls[0]?.[0]).toContain(
          "openclaw channels dead-letters list --channel telegram --account ops",
        );
      },
    );
  });
});
