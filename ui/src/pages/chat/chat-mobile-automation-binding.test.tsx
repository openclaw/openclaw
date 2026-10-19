import type { CronHistoryResult } from "@openclaw/gateway-protocol";
/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob, CronRunLogEntry } from "../../api/types.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMobileAutomationBinding } from "./chat-mobile-automation-binding.ts";

it("retires cached automation data and pending transcripts on same-client read revocation", async () => {
  const job: CronJob = {
    id: "private-job",
    name: "Private automation",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Private task" },
    state: {},
  };
  const entry: CronRunLogEntry = {
    jobId: job.id,
    runId: "private-run",
    ts: 1,
    action: "finished",
    status: "ok",
    summary: "Private history",
  };
  const pending = createDeferred<CronHistoryResult>();
  let definitions = 0;
  const request = createGatewayRequestMock().mockImplementation(async (method) => {
    if (method === "cron.get") {
      definitions++;
      return { ...job, name: definitions === 1 ? job.name : "Restored automation" };
    }
    if (method === "cron.runs") {
      return { entries: [entry], total: 1, hasMore: false, nextOffset: null };
    }
    if (method === "cron.history") {
      return pending.promise;
    }
    throw new Error("Unexpected method: " + method);
  });
  const client = createTestGatewayClient(request);
  const gateway = createApplicationGateway({
    ...createApplicationGateway().gateway.snapshot,
    client,
    phase: "connected",
    hello: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes: ["operator.read"] } },
  });
  const original = gateway.gateway.snapshot;
  const host = document.createElement("section");
  const trigger = document.createElement("button");
  document.body.append(host, trigger);
  onTestFinished(() => {
    host.remove();
    trigger.remove();
  });
  let binding!: ReturnType<typeof createMobileAutomationBinding>;
  mountSolid(
    () => {
      binding = createMobileAutomationBinding({
        context: { gateway: gateway.gateway, basePath: "", navigate: vi.fn() },
        jobId: () => job.id,
        agentId: () => "main",
        presented: () => true,
        host: () => host,
        onTranscript: vi.fn(),
        onTranscriptClose: vi.fn(),
      });
      return <div />;
    },
    { container: host },
  );
  await waitForSolid(() => expect(binding.body()?.history.runs).toEqual([entry]));
  expect(definitions).toBe(1);
  const oldBody = binding.body()!;
  oldBody.history.onViewRunTranscript(entry, trigger);
  expect(binding.transcript.entry).toEqual(entry);
  const historyRequests = () =>
    request.mock.calls.filter(([method]) => method === "cron.history").length;
  expect(historyRequests()).toBe(1);
  gateway.publish({
    ...original,
    hello: { ...original.hello!, auth: { role: "operator", scopes: [] } },
  });
  oldBody.history.onViewRunTranscript(entry, trigger);
  expect(historyRequests()).toBe(1);
  flush();
  expect(binding.body()).toBeUndefined();
  expect(binding.transcript.entry).toBeNull();
  expect(binding.transcript.messages).toEqual([]);
  gateway.publish(original);
  await waitForSolid(() => expect(binding.body()?.job.name).toBe("Restored automation"));
  expect(definitions).toBe(2);
  pending.resolve({ messages: [{ role: "assistant", content: "Retired private transcript" }] });
  await pending.promise;
  await Promise.resolve();
  flush();
  expect(binding.body()?.job.name).toBe("Restored automation");
  expect(binding.transcript.entry).toBeNull();
  expect(binding.transcript.messages).toEqual([]);
});
