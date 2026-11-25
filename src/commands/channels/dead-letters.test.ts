import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { ExpectedCliError } from "../../cli/expected-cli-error.js";
import { defaultRuntime } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";
import {
  channelsDeadLettersListCommand,
  channelsDeadLettersResubmitCommand,
} from "./dead-letters.js";

const stateOptions = { layout: "state-only", prefix: "openclaw-channel-dead-letters-" } as const;

async function withFailedEvent(
  scope: { channelId: string; accountId?: string },
  run: (queue: ReturnType<typeof createChannelIngressQueue<{ text: string }>>) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(stateOptions, async () => {
    const queue = createChannelIngressQueue<{ text: string }>(scope);
    await queue.enqueue("event-1", { text: "recover me" });
    const claim = await queue.claim("event-1", { ownerId: "worker" });
    assert(claim, "Expected a claimed ingress event");
    await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
    await run(queue);
  });
}

describe("channel dead-letter commands", () => {
  const runtime = createTestRuntime();
  beforeEach(() => {
    runtime.log.mockClear();
    vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["ops", undefined])("lists retained failures for account %s as JSON", async (account) => {
    await withFailedEvent({ channelId: "telegram", accountId: account }, async () => {
      await channelsDeadLettersListCommand({ channel: "telegram", account, json: true });
      expect(defaultRuntime.writeJson).toHaveBeenNthCalledWith(1, {
        channelId: "telegram",
        accountId: account ?? "default",
        deadLetters: [
          expect.objectContaining({
            id: "event-1",
            payload: { text: "recover me" },
            reason: "handler-error",
          }),
        ],
      });
    });
  });

  it("resubmits through the queue API and reports completed events as terminal", async () => {
    await withFailedEvent({ channelId: "line" }, async (queue) => {
      await channelsDeadLettersResubmitCommand("event-1", { channel: "line" });
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("within 5 minutes by default (longer if configured)"),
      );
      const replay = await queue.claimNext({ ownerId: "replay-worker" });
      expect(replay).toMatchObject({ id: "event-1", payload: { text: "recover me" } });
      assert(replay, "Expected a resubmitted ingress event");
      await queue.complete(replay, { completedAt: 40 });

      await expect(
        channelsDeadLettersResubmitCommand("event-1", { channel: "line" }),
      ).rejects.toThrow("is completed and cannot be resubmitted");
    });
  });

  it.each(
    [
      { channel: "telegram", account: "" },
      { channel: "telegram", account: " \t " },
      { channel: " \t ", account: undefined },
    ].flatMap((selectors) => ["list", "resubmit"].map((command) => ({ selectors, command }))),
  )("rejects blank selectors at the $command boundary", async ({ selectors, command }) => {
    await withOpenClawTestState(stateOptions, async () => {
      const options = { ...selectors, json: true };
      const action =
        command === "list"
          ? channelsDeadLettersListCommand(options)
          : channelsDeadLettersResubmitCommand("event-1", options);
      await expect(action).rejects.toThrow(ExpectedCliError);
      await expect(action).rejects.toThrow(
        selectors.channel?.trim() ? "--account must not be blank" : "--channel is required.",
      );
      expect(runtime.log).not.toHaveBeenCalled();
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    });
  });
});
