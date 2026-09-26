// Hook dispatch must retain its own lane so saturated cron work cannot starve it.
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { CommandLane } from "../process/lanes.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await import("./server.js");

const HOOK_TOKEN = "hook-secret";

afterEach(() => {
  drainSystemEvents(resolveMainSessionKeyFromConfig());
  vi.restoreAllMocks();
});

async function postHook(
  port: number,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HOOK_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function waitForCronIsolatedRuns(count: number): Promise<void> {
  await expect
    .poll(() => cronIsolatedRun.mock.calls.length, { timeout: 2_000, interval: 10 })
    .toBe(count);
}

describe("gateway hook dispatch lane", () => {
  test("dispatches hook agent runs into the hook lane, not the cron lane", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementation(async (params: unknown) => {
        (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });

      const response = await postHook(
        port,
        "/hooks/agent",
        { message: "Dispatch" },
        "hook-lane-idem",
      );
      expect(response.status).toBe(200);
      await waitForCronIsolatedRuns(1);

      const [dispatched] = cronIsolatedRun.mock.calls[0] as [{ lane?: string }];
      expect(dispatched.lane).toBe(CommandLane.HookDispatch);
      // The regression this guards: `"cron"` is the value that used to be passed.
      expect(dispatched.lane).not.toBe(CommandLane.Cron);
    });
  });
});
