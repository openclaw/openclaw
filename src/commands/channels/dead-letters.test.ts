// Channels dead-letter command tests exercise the operator-visible recovery path.
import { describe, expect, it } from "vitest";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";
import {
  channelsDeadLettersListCommand,
  channelsDeadLettersResubmitCommand,
} from "./dead-letters.js";

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-channel-dead-letters-" },
    ({ stateDir }) => run(stateDir),
  );
}

describe("channel dead-letter commands", () => {
  it("lists retained failures as JSON", async () => {
    await withTempState(async () => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
      });
      await queue.enqueue("event-1", { text: "recover me" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const runtime = createTestRuntime();

      await channelsDeadLettersListCommand(
        { channel: "telegram", account: "ops", json: true },
        runtime,
      );

      const output = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
        deadLetters: Array<{ id: string; payload?: unknown; reason: string }>;
      };
      expect(output.deadLetters).toEqual([
        expect.objectContaining({
          id: "event-1",
          payload: { text: "recover me" },
          reason: "handler-error",
        }),
      ]);
    });
  });

  it("resubmits through the queue API and reports completed events as terminal", async () => {
    await withTempState(async () => {
      const queue = createChannelIngressQueue<{ text: string }>({ channelId: "line" });
      await queue.enqueue("event-1", { text: "once" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const runtime = createTestRuntime();

      await channelsDeadLettersResubmitCommand("event-1", { channel: "line" }, runtime);
      const replay = await queue.claimNext({ ownerId: "replay-worker" });
      expect(replay).toMatchObject({ id: "event-1", payload: { text: "once" } });
      if (!replay) {
        throw new Error("Expected a resubmitted ingress event");
      }
      await queue.complete(replay, { completedAt: 40 });

      await expect(
        channelsDeadLettersResubmitCommand("event-1", { channel: "line" }, runtime),
      ).rejects.toThrow("is completed and cannot be resubmitted");
    });
  });

  it.each(
    [
      { account: "", label: "empty" },
      { account: " \t ", label: "whitespace" },
    ].flatMap((accountCase) => [
      { ...accountCase, command: "list" as const },
      { ...accountCase, command: "resubmit" as const },
    ]),
  )("rejects a $label --account at the $command boundary", async ({ account, command }) => {
    await withTempState(async () => {
      const runtime = createTestRuntime();
      const action =
        command === "list"
          ? channelsDeadLettersListCommand({ channel: "telegram", account, json: true }, runtime)
          : channelsDeadLettersResubmitCommand(
              "event-1",
              { channel: "telegram", account },
              runtime,
            );

      await expect(action).rejects.toThrow("--account must not be blank");
      expect(runtime.log).not.toHaveBeenCalled();
    });
  });

  it("still resolves an omitted --account to the default account", async () => {
    await withTempState(async () => {
      const queue = createChannelIngressQueue<{ text: string }>({ channelId: "telegram" });
      await queue.enqueue("event-1", { text: "default scope" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const runtime = createTestRuntime();

      await channelsDeadLettersListCommand({ channel: "telegram", json: true }, runtime);

      const output = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
        accountId: string;
        deadLetters: Array<{ id: string }>;
      };
      expect(output.accountId).toBe("default");
      expect(output.deadLetters).toEqual([expect.objectContaining({ id: "event-1" })]);
    });
  });
});
