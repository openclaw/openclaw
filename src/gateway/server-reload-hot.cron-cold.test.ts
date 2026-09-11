import { expect, it, vi } from "vitest";

vi.mock("./server-cron.js", () => {
  throw new Error("reload handlers loaded cron execution before a cron restart");
});

it("imports reload handlers without loading cron execution", async () => {
  const { createGatewayReloadHandlers } = await import("./server-reload-hot.js");
  expect(createGatewayReloadHandlers).toBeTypeOf("function");
});
