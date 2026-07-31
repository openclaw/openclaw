import { afterEach, describe, expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { resolveSystemEventQueueKey } from "../infra/system-event-queue-key.js";
import { drainSystemEvents, peekSystemEventEntries } from "../infra/system-events.js";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
await import("./server.js");

const HOOK_TOKEN = "hook-secret";

function resolveMainKey(): string {
  const cfg = getRuntimeConfig();
  const sessionKey =
    cfg.session?.scope === "global"
      ? "global"
      : resolveAgentMainSessionKey({ cfg, agentId: "main" });
  return resolveSystemEventQueueKey({ sessionKey, agentId: "main" });
}

async function waitForSystemEvent(): Promise<void> {
  await expect
    .poll(() => peekSystemEventEntries(resolveMainKey()), { timeout: 2_000, interval: 10 })
    .not.toHaveLength(0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function postWake(port: number, token = HOOK_TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hooks/wake`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "wake" }),
  });
}

describe("gateway hook auth rate limiting", () => {
  test("throttles repeated hook auth failures and resets after success", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      expect((await postWake(port, "wrong")).status).toBe(401);

      let throttled: Response | null = null;
      for (let i = 0; i < 20; i++) {
        throttled = await postWake(port, "wrong");
      }
      expect(throttled?.status).toBe(429);
      expect(throttled?.headers.get("retry-after")).toMatch(/^\d+$/);

      expect((await postWake(port)).status).toBe(200);
      await waitForSystemEvent();
      drainSystemEvents(resolveMainKey());
      expect((await postWake(port, "wrong")).status).toBe(401);
    });
  });

  test("rejects non-POST hook requests without consuming auth failure budget", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      let lastGet: Response | null = null;
      for (let i = 0; i < 21; i++) {
        lastGet = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
          method: "GET",
          headers: { Authorization: "Bearer wrong" },
        });
      }
      expect(lastGet?.status).toBe(405);
      expect(lastGet?.headers.get("allow")).toBe("POST");
      expect((await postWake(port)).status).toBe(200);
      await waitForSystemEvent();
      drainSystemEvents(resolveMainKey());
    });
  });
});
