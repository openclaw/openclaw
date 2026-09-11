import { expect, it, vi } from "vitest";

vi.mock("../infra/heartbeat-runner.js", () => {
  throw new Error("scheduled services loaded the broad heartbeat facade");
});

vi.mock("../infra/heartbeat-runner-run.js", () => {
  throw new Error("scheduled services loaded heartbeat execution before a wake");
});

vi.mock("../infra/heartbeat-runner-config.js", () => {
  throw new Error("scheduled services loaded model, channel, and reply configuration");
});

it("imports the scheduled-service factory without heartbeat execution", async () => {
  const { activateGatewayScheduledServices } = await import("./server-runtime-services.js");
  expect(activateGatewayScheduledServices).toBeTypeOf("function");
});
