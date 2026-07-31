import { expect, test } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { resolveSystemEventQueueKey } from "../infra/system-event-queue-key.js";
import { drainSystemEvents, peekSystemEventEntries } from "../infra/system-events.js";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
await import("./server.js");

const HOOK_TOKEN = "hook-secret";

async function postHook(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HOOK_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function waitForSystemEvent(sessionKey: string): Promise<string[]> {
  await expect
    .poll(() => peekSystemEventEntries(sessionKey).map((event) => event.text), {
      timeout: 2_000,
      interval: 10,
    })
    .not.toHaveLength(0);
  return peekSystemEventEntries(sessionKey).map((event) => event.text);
}

test("routes direct and mapped wake hooks to explicit fleet owners", async () => {
  testState.agentsConfig = {
    ownership: "explicit",
    entries: { main: {}, hooks: {} },
  };
  testState.hooksConfig = {
    enabled: true,
    token: HOOK_TOKEN,
    mappings: [
      {
        match: { path: "mapped-wake" },
        action: "wake",
        agentId: "hooks",
        textTemplate: "Mapped wake",
      },
    ],
  };

  await withGatewayServer(async ({ port }) => {
    const cfg = getRuntimeConfig();
    const queueKey = (agentId: string) =>
      resolveSystemEventQueueKey({
        sessionKey: resolveAgentMainSessionKey({ cfg, agentId }),
        agentId,
      });
    const mainQueueKey = queueKey("main");
    const hooksQueueKey = queueKey("hooks");

    const direct = await postHook(port, "/hooks/wake", {
      text: "Direct wake",
      agentId: "main",
    });
    expect(direct.status).toBe(200);
    expect(await waitForSystemEvent(mainQueueKey)).toContain("Direct wake");
    drainSystemEvents(mainQueueKey);

    const mapped = await postHook(port, "/hooks/mapped-wake", {});
    expect(mapped.status).toBe(200);
    expect(await waitForSystemEvent(hooksQueueKey)).toContain("Mapped wake");
    drainSystemEvents(hooksQueueKey);
  });
});
