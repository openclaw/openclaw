import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { DEDUPE_TTL_MS } from "./server-constants.js";
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

      // The verified webhook-id is the replay identity: a redelivery replays, it does not re-run,
      // and unsigned headers (Idempotency-Key, a bearer the signed path never checks) cannot mint
      // a fresh identity for the same signed bytes.
      const replayed = await post(port, "/hooks/ambush", BODY, { headers: signedHeaders("msg_1") });
      expect(replayed.status).toBe(200);
      const replayedNewKey = await post(port, "/hooks/ambush", BODY, {
        headers: { ...signedHeaders("msg_1"), "Idempotency-Key": "fresh-key" },
      });
      expect(replayedNewKey.status).toBe(200);
      const replayedNewBearer = await post(port, "/hooks/ambush", BODY, {
        token: "some-other-token",
        headers: signedHeaders("msg_1"),
      });
      expect(replayedNewBearer.status).toBe(200);
      const replayedAlias = await post(port, "/hooks/ambush/", BODY, {
        headers: signedHeaders("msg_1"),
      });
      expect(replayedAlias.status).toBe(200);
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

      // Built-in endpoints and unsigned paths keep the token contract, and a signature
      // that is valid for the mapped path buys nothing there.
      const wakeNoAuth = await post(port, "/hooks/wake", JSON.stringify({ text: "Ping" }));
      expect(wakeNoAuth.status).toBe(401);
      const wakeSigned = await post(port, "/hooks/wake", BODY, { headers: signedHeaders("msg_6") });
      expect(wakeSigned.status).toBe(401);
      const wakeToken = await post(port, "/hooks/wake", JSON.stringify({ text: "Ping" }), {
        token: HOOK_TOKEN,
      });
      expect(wakeToken.status).toBe(200);
      const agentToken = await post(port, "/hooks/agent", JSON.stringify({ message: "Do it" }), {
        token: HOOK_TOKEN,
      });
      expect(agentToken.status).toBe(200);
      await waitForCronRuns(2);
    });
  });

  test("dedupes signed wake redeliveries, including path aliases", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "ambush" },
          action: "wake",
          textTemplate: "Ambush: {{payload.data.headline}}",
          signature: { scheme: "standard-webhooks", secret: SECRET },
        },
      ],
    };
    testState.agentsConfig = { entries: { main: { default: true } } };

    await withGatewayServer(async ({ port }) => {
      const first = await post(port, "/hooks/ambush", BODY, { headers: signedHeaders("msg_w1") });
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({ ok: true, eventOutcome: "queued" });

      const again = await post(port, "/hooks/ambush", BODY, { headers: signedHeaders("msg_w1") });
      expect(again.status).toBe(200);
      await expect(again.json()).resolves.toMatchObject({ ok: true, eventOutcome: "duplicate" });

      const alias = await post(port, "/hooks/ambush/", BODY, { headers: signedHeaders("msg_w1") });
      expect(alias.status).toBe(200);
      await expect(alias.json()).resolves.toMatchObject({ ok: true, eventOutcome: "duplicate" });

      // A new delivery id with a different payload is a new wake (identical text would coalesce).
      const otherBody = BODY.replace("GPT-6", "GPT-7");
      const fresh = await post(port, "/hooks/ambush", otherBody, {
        headers: signedHeaders("msg_w2", { body: otherBody }),
      });
      expect(fresh.status).toBe(200);
      await expect(fresh.json()).resolves.toMatchObject({ ok: true, eventOutcome: "queued" });
    });
  });

  test("unsigned template inputs cannot mint a new replay identity for signed bytes", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "ambush" },
          action: "agent",
          messageTemplate: "Ambush: {{payload.data.headline}} via {{headers.x-variant}}",
          signature: { scheme: "standard-webhooks", secret: SECRET },
        },
      ],
    };
    testState.agentsConfig = { entries: { main: { default: true } } };

    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });
      const first = await post(port, "/hooks/ambush", BODY, {
        headers: { ...signedHeaders("msg_t1"), "x-variant": "a" },
      });
      expect(first.status).toBe(200);
      await waitForCronRuns(1);
      const variant = await post(port, "/hooks/ambush", BODY, {
        headers: { ...signedHeaders("msg_t1"), "x-variant": "b" },
      });
      expect(variant.status).toBe(200);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
    });
  });

  test("keeps signed replay records for the whole signature window", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "ambush" },
          action: "agent",
          messageTemplate: "Ambush: {{payload.data.headline}}",
          signature: { scheme: "standard-webhooks", secret: SECRET, toleranceSeconds: 900 },
        },
      ],
    };
    testState.agentsConfig = { entries: { main: { default: true } } };

    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });
      const startMs = 1_800_000_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(startMs);
      try {
        const headers = signedHeaders("msg_long", {
          timestamp: String(Math.floor(startMs / 1000)),
        });
        const first = await post(port, "/hooks/ambush", BODY, { headers });
        expect(first.status).toBe(200);
        await waitForCronRuns(1);
        // Past the generic 5-minute dedupe floor but inside the 900s signature window.
        nowSpy.mockReturnValue(startMs + DEDUPE_TTL_MS + 60_000);
        const late = await post(port, "/hooks/ambush", BODY, { headers });
        expect(late.status).toBe(200);
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  test("dedupes each item of a signed fan-out wake delivery", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "batch" },
          action: "wake",
          forEach: "items",
          textTemplate: "Batch: {{items[0].headline}}",
          signature: { scheme: "standard-webhooks", secret: SECRET },
        },
      ],
    };
    testState.agentsConfig = { entries: { main: { default: true } } };

    await withGatewayServer(async ({ port }) => {
      const batch = JSON.stringify({ items: [{ headline: "one" }, { headline: "two" }] });
      const first = await post(port, "/hooks/batch", batch, {
        headers: signedHeaders("msg_b1", { body: batch }),
      });
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({ ok: true, eventOutcome: "queued" });
      const again = await post(port, "/hooks/batch", batch, {
        headers: signedHeaders("msg_b1", { body: batch }),
      });
      expect(again.status).toBe(200);
      await expect(again.json()).resolves.toMatchObject({ ok: true, eventOutcome: "duplicate" });
    });
  });
});
