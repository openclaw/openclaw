import { expect, it, vi } from "vitest";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";

vi.mock("./server-cron.js", () => {
  throw new Error("reload handlers loaded cron execution before a cron restart");
});

it("imports reload handlers without loading cron execution", async () => {
  expect(createGatewayReloadHandlers).toBeTypeOf("function");
});
