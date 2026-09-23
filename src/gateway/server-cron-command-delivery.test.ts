import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronJob } from "../cron/types.js";
import { finalizeCronCompletionAnnouncement } from "./server-cron-command-delivery.js";

const commandCompletionRetention = {
  idPrefix: "cron-command-delivery:v1:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

const sendCronAnnouncePayloadStrict = vi.hoisted(() => vi.fn());

vi.mock("../cron/delivery.js", async () => {
  const actual = await vi.importActual<typeof import("../cron/delivery.js")>("../cron/delivery.js");
  return { ...actual, sendCronAnnouncePayloadStrict };
});

function commandJob(): CronJob {
  return {
    id: "job-command",
    name: "command",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "command", argv: ["true"] },
    delivery: { mode: "announce", channel: "matrix", to: "private-room", accountId: "private" },
    state: { runningAtMs: 1_000 },
  };
}

describe("gateway command cron delivery custody", () => {
  beforeEach(() => {
    sendCronAnnouncePayloadStrict.mockReset();
    sendCronAnnouncePayloadStrict.mockResolvedValue({
      status: "sent",
      results: [{ channel: "matrix", messageId: "message-1" }],
    });
  });

  it("binds the task identity to a target-free durable intent", async () => {
    const taskIdentity = { taskId: "task-1", runId: "cron:job-command:1000:receipt-1" };

    await expect(
      finalizeCronCompletionAnnouncement({
        job: commandJob(),
        text: "command output",
        deps: {} as CliDeps,
        resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
        logger: { warn: vi.fn() },
        label: "command",
        taskIdentity,
      }),
    ).resolves.toMatchObject({ deliveryState: { status: "delivered", delivered: true } });

    expect(sendCronAnnouncePayloadStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryIntentId: `${commandCompletionRetention.idPrefix}task-1`,
        deliveryCompletion: {
          kind: "cron-task",
          taskId: "task-1",
          runId: taskIdentity.runId,
          intentId: `${commandCompletionRetention.idPrefix}task-1`,
        },
        completionRetention: commandCompletionRetention,
      }),
    );
    const custody = sendCronAnnouncePayloadStrict.mock.calls[0]?.[0].deliveryCompletion;
    expect(JSON.stringify(custody)).not.toContain("private-room");
    expect(JSON.stringify(custody)).not.toContain('"private"');
  });

  it("preserves backward compatibility when no task row was created", async () => {
    await finalizeCronCompletionAnnouncement({
      job: commandJob(),
      text: "command output",
      deps: {} as CliDeps,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      logger: { warn: vi.fn() },
      label: "command",
    });

    expect(sendCronAnnouncePayloadStrict).toHaveBeenCalledWith(
      expect.not.objectContaining({ deliveryIntentId: expect.anything() }),
    );
  });
});
