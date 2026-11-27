import { afterEach, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { proveSubscriptionDoesNotWaitForDisplayRows } from "./sessions.messages-subscribe-wait.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it("acknowledges authorized observers while active-turn display facts are pending", async ({
  signal,
}) => {
  await proveSubscriptionDoesNotWaitForDisplayRows(1, signal);
});
