// Doctor channel ingress tests cover dead-letter visibility and recovery guidance.
import { describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { noteChannelIngressDeadLetters } from "./doctor-channel-ingress.js";

describe("noteChannelIngressDeadLetters", () => {
  it("mentions affected channel accounts and the inspection command", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-doctor-ingress-", applyEnv: false },
      async ({ stateDir }) => {
        const queue = createChannelIngressQueue<{ text: string }>({
          channelId: "telegram",
          accountId: "ops",
          stateDir,
        });
        await queue.enqueue("event-1", { text: "recover me" });
        const claim = await queue.claim("event-1", { ownerId: "worker" });
        if (!claim) {
          throw new Error("Expected a claimed ingress event");
        }
        await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
        const noteFn = vi.fn();

        await noteChannelIngressDeadLetters({ stateDir, noteFn });

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
