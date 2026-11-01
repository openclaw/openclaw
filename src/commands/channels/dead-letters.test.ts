import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
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
    if (!claim) {
      throw new Error("Expected a claimed ingress event");
    }
    await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
    await run(queue);
  });
}

describe("channel dead-letter commands", () => {
  const runtime = createTestRuntime();
  beforeEach(() => {
    runtime.log.mockClear();
    vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) =>
      runtime.log(JSON.stringify(value, null, 2)),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["ops", undefined])("lists retained failures for account %s as JSON", async (account) => {
    await withFailedEvent({ channelId: "telegram", accountId: account }, async () => {
      await channelsDeadLettersListCommand({ channel: "telegram", account, json: true });
      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
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

  it.each([
    { stored: "telegram", requested: "Telegram" },
    { stored: "imessage", requested: "IMSG" },
    { stored: "msteams", requested: "teams" },
    { stored: "mcp-events", requested: "mcp-events" },
  ])("lists $stored failures requested as $requested", async ({ stored, requested }) => {
    await withFailedEvent({ channelId: stored }, async () => {
      await channelsDeadLettersListCommand({ channel: requested, json: true });
      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toMatchObject({
        channelId: stored,
        deadLetters: [expect.objectContaining({ id: "event-1" })],
      });
    });
  });

  it("resubmits a failure addressed by a channel alias", async () => {
    await withFailedEvent({ channelId: "imessage" }, async (queue) => {
      await channelsDeadLettersResubmitCommand("event-1", { channel: "imsg" });
      expect(await queue.claimNext({ ownerId: "replay-worker" })).toMatchObject({
        id: "event-1",
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
      if (!replay) {
        throw new Error("Expected a resubmitted ingress event");
      }
      await queue.complete(replay, { completedAt: 40 });

      await expect(
        channelsDeadLettersResubmitCommand("event-1", { channel: "line" }),
      ).rejects.toThrow("is completed and cannot be resubmitted");
    });
  });

  it.each(
    ["", " \t "].flatMap((account) => [
      { account, command: "list" },
      { account, command: "resubmit" },
    ]),
  )("rejects blank --account '$account' at the $command boundary", async ({ account, command }) => {
    await withOpenClawTestState(stateOptions, async () => {
      const options = { channel: "telegram", account, json: true };
      const action =
        command === "list"
          ? channelsDeadLettersListCommand(options)
          : channelsDeadLettersResubmitCommand("event-1", options);
      await expect(action).rejects.toThrow("--account must not be blank");
      expect(runtime.log).not.toHaveBeenCalled();
    });
  });
});
