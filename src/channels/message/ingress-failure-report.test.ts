import { afterEach, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createIngressFailureReporter } from "./ingress-failure-report.js";
import type { ChannelIngressQueueClaim } from "./ingress-queue.types.js";

afterEach(resetGlobalHookRunner);

function claim(): ChannelIngressQueueClaim<unknown> {
  return {
    channelId: "telegram",
    accountId: "account-one",
    queueName: "ingress:telegram:account-one",
    id: "event-one",
    receivedAt: 10,
    updatedAt: 20,
    attempts: 7,
    claim: { token: "private-token", ownerId: "private-owner", claimedAt: 20 },
    get payload() {
      throw new Error("PRIVATE_PAYLOAD_READ");
    },
    get metadata() {
      throw new Error("PRIVATE_METADATA_READ");
    },
  };
}

it("delivers original ingress identity to an actual plugin hook without a fabricated run", async () => {
  const observed: unknown[] = [];
  const { registry } = createHookRunnerWithRegistry([
    {
      hookName: "channel_ingress_failed",
      handler: (event, context) => {
        observed.push({ event, context });
      },
    },
  ]);
  initializeGlobalHookRunner(registry);
  const notify = vi.fn();
  await createIngressFailureReporter(
    notify,
    vi.fn(),
    String,
  )(claim(), { reason: "handler-error", message: "PRIVATE_ERROR", attempt: 8 });
  expect(observed).toEqual([
    {
      event: {
        eventId: "event-one",
        queueName: "ingress:telegram:account-one",
        receivedAt: 10,
        attempts: 8,
      },
      context: { channelId: "telegram", accountId: "account-one" },
    },
  ]);
  expect(JSON.stringify(observed)).not.toContain("PRIVATE_");
  expect(JSON.stringify(observed)).not.toContain("runId");
  expect(notify).toHaveBeenCalledOnce();
});

it("does not turn a failed observer into an event replay or suppress the existing notice", async () => {
  const notify = vi.fn();
  const failing = vi.fn().mockRejectedValue(new Error("observer unavailable"));
  const { registry } = createHookRunnerWithRegistry([
    { hookName: "channel_ingress_failed", handler: failing },
  ]);
  initializeGlobalHookRunner(registry);
  await createIngressFailureReporter(
    notify,
    vi.fn(),
    String,
  )(claim(), { reason: "handler-error", message: "failed", attempt: 8 });
  expect(failing).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledOnce();
});
