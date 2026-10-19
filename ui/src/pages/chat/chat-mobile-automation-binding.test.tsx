import type { CronHistoryResult } from "@openclaw/gateway-protocol";
/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
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
  const onTranscriptClose = vi.fn();
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
        onTranscriptClose,
      });
      return <div>{binding.lifecycle}</div>;
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
  flush();
  oldBody.history.onViewRunTranscript(entry, trigger);
  flush();
  expect(onTranscriptClose).not.toHaveBeenCalled();
  expect(historyRequests()).toBe(2);
  gateway.publish({
    ...original,
    hello: { ...original.hello!, auth: { role: "operator", scopes: [] } },
  });
  oldBody.history.onViewRunTranscript(entry, trigger);
  expect(historyRequests()).toBe(2);
  flush();
  expect(binding.body()).toBeUndefined();
  expect(binding.transcript.entry).toBeNull();
  expect(binding.transcript.messages).toEqual([]);
  expect(onTranscriptClose).toHaveBeenCalledTimes(1);
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

it("catches up once on reveal and refreshes admin-only scratch without resetting the tab", async () => {
  const job: CronJob = {
    id: "heartbeat-job",
    name: "Heartbeat automation",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "heartbeat" },
    state: {},
  };
  const pending = createDeferred<{ scratch: { content: string } }>();
  let scratches = 0;
  const request = createGatewayRequestMock().mockImplementation(async (method) => {
    if (method === "cron.get") {
      return job;
    }
    if (method === "cron.runs") {
      return { entries: [], total: 0, hasMore: false, nextOffset: null };
    }
    if (method === "cron.scratch.get") {
      return ++scratches === 1 ? pending.promise : { scratch: { content: "Current scratch" } };
    }
    throw new Error("Unexpected method: " + method);
  });
  const gateway = createApplicationGateway({
    ...createApplicationGateway().gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: {
      type: "hello-ok",
      protocol: 4,
      auth: { role: "operator", scopes: ["operator.admin"] },
    },
  });
  const authorized = gateway.gateway.snapshot;
  const [presented, setPresented] = createSignal(false);
  const host = document.createElement("section");
  document.body.append(host);
  onTestFinished(() => host.remove());
  let binding!: ReturnType<typeof createMobileAutomationBinding>;
  const view = mountSolid(
    () => {
      binding = createMobileAutomationBinding({
        context: { gateway: gateway.gateway, basePath: "", navigate: vi.fn() },
        jobId: () => job.id,
        agentId: () => "main",
        presented,
        host: () => host,
        onTranscript: vi.fn(),
        onTranscriptClose: vi.fn(),
      });
      return <div>{binding.lifecycle}</div>;
    },
    { container: host },
  );
  flush();
  expect(request).not.toHaveBeenCalled();
  setPresented(true);
  await waitForSolid(() => expect(scratches).toBe(1));
  binding.body()!.onTabChange("history");
  setPresented(false);
  flush();
  gateway.publishEvent({ type: "event", event: "cron", payload: { jobId: job.id } });
  gateway.publishEvent({ type: "event", event: "cron", payload: { jobId: job.id } });
  pending.resolve({ scratch: { content: "Retired scratch" } });
  await pending.promise;
  await Promise.resolve();
  flush();
  expect(binding.body()?.heartbeatScratch).toBe("");
  expect(scratches).toBe(1);
  setPresented(true);
  await waitForSolid(() => expect(binding.body()?.heartbeatScratch).toBe("Current scratch"));
  expect(scratches).toBe(2);
  expect(binding.body()?.tab).toBe("history");
  gateway.publish({
    ...authorized,
    hello: { ...authorized.hello!, auth: { role: "operator", scopes: ["operator.read"] } },
  });
  await waitForSolid(() => expect(binding.body()?.canManage).toBe(false));
  expect(binding.body()?.heartbeatScratch).toBe("");
  expect(binding.body()?.tab).toBe("history");
  gateway.publish(authorized);
  await waitForSolid(() => expect(binding.body()?.heartbeatScratch).toBe("Current scratch"));
  expect(scratches).toBe(3);
  const calls = request.mock.calls.length;
  view.unmount();
  gateway.publishEvent({ type: "event", event: "cron", payload: { jobId: job.id } });
  gateway.publish(authorized);
  flush();
  expect(request).toHaveBeenCalledTimes(calls);
});
