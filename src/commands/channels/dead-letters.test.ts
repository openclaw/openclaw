// Channels dead-letter command tests exercise the operator-visible recovery path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { defaultRuntime } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";
import {
  channelsDeadLettersListCommand,
  channelsDeadLettersDeleteCommand,
  channelsDeadLettersPurgeCommand,
  channelsDeadLettersResubmitCommand,
} from "./dead-letters.js";

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-channel-dead-letters-" },
    ({ stateDir }) => run(stateDir),
  );
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
      await channelsDeadLettersListCommand({ channel: "telegram", account: "ops", json: true });

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
      await channelsDeadLettersResubmitCommand("event-1", { channel: "line" });
      const replay = await queue.claimNext({ ownerId: "replay-worker" });
      expect(replay).toMatchObject({ id: "event-1", payload: { text: "once" } });
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
    [
      { account: "", label: "empty" },
      { account: " \t ", label: "whitespace" },
    ].flatMap((accountCase) => [
      { ...accountCase, command: "list" as const },
      { ...accountCase, command: "resubmit" as const },
    ]),
  )("rejects a $label --account at the $command boundary", async ({ account, command }) => {
    await withTempState(async () => {
      const action =
        command === "list"
          ? channelsDeadLettersListCommand({ channel: "telegram", account, json: true })
          : channelsDeadLettersResubmitCommand("event-1", { channel: "telegram", account });

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
      await channelsDeadLettersListCommand({ channel: "telegram", json: true });

      const output = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
        accountId: string;
        deadLetters: Array<{ id: string }>;
      };
      expect(output.accountId).toBe("default");
      expect(output.deadLetters).toEqual([expect.objectContaining({ id: "event-1" })]);
    });
  });

  it("deletes only failed events with force", async () => {
    await withTempState(async () => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
      });
      await queue.enqueue("event-1", { text: "discard" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected claim");
      }
      await queue.fail(claim, { reason: "bad", failedAt: 20 });
      await channelsDeadLettersDeleteCommand("event-1", {
        channel: "telegram",
        account: "ops",
        force: true,
      });
      await expect(queue.listFailed?.({ limit: "all" })).resolves.toEqual([]);
      await expect(queue.enqueue("event-1", { text: "replay" })).resolves.toMatchObject({
        kind: "accepted",
      });
    });
  });

  it("purges failed events only in the selected scope and preserves active and completed rows", async () => {
    await withTempState(async () => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
      });
      for (const id of ["event-1", "event-2"]) {
        await queue.enqueue(id, { text: id });
        const claim = await queue.claim(id, { ownerId: "worker" });
        if (!claim) {
          throw new Error("Expected claim");
        }
        await queue.fail(claim, { reason: "bad", failedAt: 20 });
      }
      await queue.enqueue("pending", { text: "pending" });
      await queue.enqueue("claimed", { text: "claimed" });
      await queue.claim("claimed");
      await queue.complete("completed");
      const other = createChannelIngressQueue({ channelId: "telegram", accountId: "other" });
      await other.enqueue("event-1", { text: "other account" });
      await other.fail("event-1", { reason: "bad", failedAt: 20 });
      await channelsDeadLettersPurgeCommand({ channel: "telegram", account: "ops", force: true });
      await expect(queue.listFailed?.({ limit: "all" })).resolves.toEqual([]);
      expect((await queue.listPending()).map((row) => row.id)).toEqual(["pending"]);
      expect((await queue.listClaims()).map((row) => row.id)).toEqual(["claimed"]);
      await expect(queue.enqueue("completed", { text: "duplicate" })).resolves.toMatchObject({
        kind: "completed",
      });
      await expect(other.listFailed?.()).resolves.toEqual([
        expect.objectContaining({ id: "event-1" }),
      ]);
    });
  });
});
