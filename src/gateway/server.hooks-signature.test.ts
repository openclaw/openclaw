import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
await import("./server.js");

const HOOK_TOKEN = "hook-secret";
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const OTHER_SECRET = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
const BODY = JSON.stringify({ id: "evt-1", data: { headline: "GPT-6 announced" } });

afterEach(() => {
  drainSystemEvents(resolveMainSessionKeyFromConfig());
  vi.restoreAllMocks();
});

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function signedHeaders(
  id: string,
  options?: { timestamp?: string; secret?: string; body?: string },
): Record<string, string> {
  const timestamp = options?.timestamp ?? String(Math.floor(Date.now() / 1000));
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": sign(options?.secret ?? SECRET, id, timestamp, options?.body ?? BODY),
  };
}

async function post(
  port: number,
  path: string,
  body: string,
  options?: { token?: string | null; headers?: Record<string, string> },
): Promise<Response> {
  const token = options?.token === undefined ? null : options.token;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
    body,
  });
}

async function waitForCronRuns(count: number): Promise<void> {
  await expect
    .poll(() => cronIsolatedRun.mock.calls.length, { timeout: 2_000, interval: 10 })
    .toBe(count);
}

describe("gateway hook sender signatures", () => {
  test("authenticates a signed mapped hook without the shared token", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "ambush" },
          action: "agent",
          messageTemplate: "Ambush: {{payload.data.headline}}",
          signature: { scheme: "standard-webhooks", secret: SECRET },
        },
      ],
    };
    testState.agentsConfig = { entries: { main: { default: true } } };

    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });

      const signed = await post(port, "/hooks/ambush", BODY, { headers: signedHeaders("msg_1") });
      expect(signed.status).toBe(200);
      await waitForCronRuns(1);
      const call = cronIsolatedRun.mock.calls.at(0)?.[0] as
        | { job?: { payload?: { externalContentSource?: string } } }
        | undefined;
      expect(call?.job?.payload?.externalContentSource).toBe("webhook");

      // webhook-id doubles as the idempotency key: a redelivery replays, it does not re-run.
      const replayed = await post(port, "/hooks/ambush", BODY, { headers: signedHeaders("msg_1") });
      expect(replayed.status).toBe(200);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      // The signature is mandatory on that path: the shared token alone is not enough.
      const tokenOnly = await post(port, "/hooks/ambush", BODY, { token: HOOK_TOKEN });
      expect(tokenOnly.status).toBe(401);

      const wrongSecret = await post(port, "/hooks/ambush", BODY, {
        headers: signedHeaders("msg_2", { secret: OTHER_SECRET }),
      });
      expect(wrongSecret.status).toBe(401);

      const tampered = await post(port, "/hooks/ambush", BODY.replace("GPT-6", "GPT-7"), {
        headers: signedHeaders("msg_3"),
      });
      expect(tampered.status).toBe(401);

      const stale = await post(port, "/hooks/ambush", BODY, {
        headers: signedHeaders("msg_4", {
          timestamp: String(Math.floor(Date.now() / 1000) - 3600),
        }),
      });
      expect(stale.status).toBe(401);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      // Paths without a signature mapping keep the token contract.
      const wakeNoAuth = await post(port, "/hooks/wake", JSON.stringify({ text: "Ping" }));
      expect(wakeNoAuth.status).toBe(401);
      const wakeToken = await post(port, "/hooks/wake", JSON.stringify({ text: "Ping" }), {
        token: HOOK_TOKEN,
      });
      expect(wakeToken.status).toBe(200);
    });
  });
});
