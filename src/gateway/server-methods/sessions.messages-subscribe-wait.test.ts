import { afterEach, it, vi } from "vitest";
import { proveSubscriptionDoesNotWaitForDisplayRows } from "./sessions.messages-subscribe-wait.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("acknowledges authorized observers while active-turn display facts are pending", async ({
  signal,
}) => {
  await proveSubscriptionDoesNotWaitForDisplayRows(1, signal);
});
