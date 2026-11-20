import { afterEach, expect, it } from "vitest";
import { initializeGatewayResourceProfile } from "./gateway-resource-profile.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import {
  claimsSharedHostSlot,
  createHostedWorker,
  type HostedWorkerEndpoint,
} from "./shared-worker-host.js";
import { getTrackedWorkerPoolSnapshot } from "./worker-cpu.js";

const sqliteStore = resolveRuntimeProcessEntrypointUrl("sqliteStore");
const live = new Set<HostedWorkerEndpoint>();

function carrier(key: string) {
  const endpoint = createHostedWorker(sqliteStore, {}, { key, ready: false });
  live.add(endpoint);
  const exited = new Promise<{ code: number; error?: Error }>((resolve) => {
    let error: Error | undefined;
    endpoint.on("error", (failure) => {
      error = failure;
    });
    endpoint.once("exit", (code) => resolve({ code, error }));
  });
  const started = new Promise<void>((resolve) => {
    endpoint.once("started", resolve);
  });
  return { endpoint, started, exited };
}

afterEach(async () => {
  for (const endpoint of live) {
    endpoint.retiring("cancelled");
    await endpoint.terminate();
  }
  live.clear();
  initializeGatewayResourceProfile({ profile: "standard" });
});

it("hosts nothing outside the lean profile", () => {
  initializeGatewayResourceProfile({ profile: "standard" });
  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(false);
});

it("replaces the whole host when one endpoint needs physical termination", async () => {
  initializeGatewayResourceProfile({ profile: "lean" });
  const agent = carrier("sqlite-store:agent");
  const shared = carrier("sqlite-store:shared-state");
  await Promise.all([agent.started, shared.started]);
  // Two logical endpoints, one physical isolate; a key admits one live endpoint.
  expect(agent.endpoint.threadId).toBe(shared.endpoint.threadId);
  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(false);
  const census = getTrackedWorkerPoolSnapshot().workerCensus;
  expect(census.find((row) => row.kind === "shared-worker-host.worker.js")).toMatchObject({
    count: 1,
    hostedEndpoints: 2,
  });

  const firstThread = agent.endpoint.threadId;
  agent.endpoint.retiring("cancelled");
  await agent.endpoint.terminate();
  const sibling = await shared.exited;
  // The uninvolved endpoint fails explicitly instead of silently losing its isolate.
  expect(sibling.code).not.toBe(0);
  expect(sibling.error?.message).toMatch(/^Shared worker host failed: sqlite-store endpoint/);
  expect(shared.endpoint.terminalFailure).toBe(sibling.error);

  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(true);
  const replacement = carrier("sqlite-store:agent");
  await replacement.started;
  expect(replacement.endpoint.threadId).not.toBe(firstThread);
});

it("detaches an idle endpoint logically and releases the host after the last one", async () => {
  initializeGatewayResourceProfile({ profile: "lean" });
  const agent = carrier("sqlite-store:agent");
  const shared = carrier("sqlite-store:shared-state");
  await Promise.all([agent.started, shared.started]);

  agent.endpoint.retiring("idle_timeout");
  await agent.endpoint.terminate();
  expect(await agent.exited).toEqual({ code: 0, error: undefined });
  expect(shared.endpoint.executionStopped).toBe(false);
  expect(claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(true);

  shared.endpoint.retiring("idle_timeout");
  await shared.endpoint.terminate();
  expect(await shared.exited).toEqual({ code: 0, error: undefined });
  // The released host exits physically before a replacement may start.
  await expect.poll(() => claimsSharedHostSlot(sqliteStore, "sqlite-store:agent")).toBe(true);
  expect(
    getTrackedWorkerPoolSnapshot().workerCensus.some(
      (row) => row.kind === "shared-worker-host.worker.js",
    ),
  ).toBe(false);
});
