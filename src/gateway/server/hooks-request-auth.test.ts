import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { resolveHookMappings } from "../hooks-mapping.js";
import type { HooksConfigResolved } from "../hooks.js";
import { admitHookRequest, createSignedWakeDeliveryLedger } from "./hooks-request-auth.js";

const SECRET_A = `whsec_${randomBytes(32).toString("base64")}`;
const SECRET_B = `whsec_${randomBytes(32).toString("base64")}`;
const BODY = JSON.stringify({ id: "evt_1", data: { headline: "GPT-6" } });

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function hooksConfig(secret: string): HooksConfigResolved {
  const mappings = resolveHookMappings(
    {
      mappings: [
        {
          match: { path: "ambush" },
          action: "wake",
          textTemplate: "x",
          signature: { scheme: "standard-webhooks", secret },
        },
      ],
    },
    { configDir: "/tmp/openclaw-hooks-request-auth-test" },
  );
  return { mappings, token: "hook-token" } as unknown as HooksConfigResolved;
}

function request(headers: Record<string, string>, body: string): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  Object.assign(req, {
    headers,
    method: "POST",
    url: "/hooks/ambush",
    socket: { destroyed: false, writableEnded: false },
  });
  return req;
}

function response() {
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  return res as unknown as ServerResponse & { statusCode: number; end: ReturnType<typeof vi.fn> };
}

const limiter = {
  check: () => ({ allowed: true, retryAfterMs: 0 }),
  recordFailure: vi.fn(),
  reset: vi.fn(),
} as unknown as Parameters<typeof admitHookRequest>[0]["limiter"];

async function admit(params: {
  initial: HooksConfigResolved;
  live: HooksConfigResolved | null;
  secret: string;
}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "webhook-id": "msg_slow",
    "webhook-timestamp": timestamp,
    "webhook-signature": sign(params.secret, "msg_slow", timestamp, BODY),
  };
  const res = response();
  const admission = await admitHookRequest({
    req: request(headers, BODY),
    res,
    hooksConfig: params.initial,
    resolveHooksConfig: () => params.live,
    subPath: "ambush",
    bodyLimit: 1024 * 1024,
    headers,
    token: undefined,
    clientKey: "test",
    limiter,
    warn: vi.fn(),
  });
  return { admission, res };
}

describe("admitHookRequest signing authority", () => {
  test("admits a signed request and reports the live mapping and tolerance", async () => {
    const config = hooksConfig(SECRET_A);
    const { admission } = await admit({ initial: config, live: config, secret: SECRET_A });
    expect(admission).toMatchObject({
      ok: true,
      signedDeliveryId: "msg_slow",
      signedMappingId: "mapping-1",
      signedToleranceSeconds: 300,
    });
  });

  test("rejects a request whose secret was rotated while the body was uploading", async () => {
    const { admission, res } = await admit({
      initial: hooksConfig(SECRET_A),
      live: hooksConfig(SECRET_B),
      secret: SECRET_A,
    });
    expect(admission).toEqual({ ok: false });
    expect(res.statusCode).toBe(401);
    expect(limiter.recordFailure).toHaveBeenCalled();
  });

  test("rejects a request whose signed mapping disappeared while the body was uploading", async () => {
    const { admission, res } = await admit({
      initial: hooksConfig(SECRET_A),
      live: null,
      secret: SECRET_A,
    });
    expect(admission).toEqual({ ok: false });
    expect(res.statusCode).toBe(401);
  });
});

describe("createSignedWakeDeliveryLedger", () => {
  test("remembers deliveries until they expire and bounds its size", () => {
    vi.useFakeTimers();
    try {
      const ledger = createSignedWakeDeliveryLedger(2);
      ledger.record("m:1", 1_000);
      expect(ledger.has("m:1")).toBe(true);
      ledger.record("m:2", 1_000);
      ledger.record("m:3", 1_000);
      expect(ledger.has("m:1")).toBe(false);
      expect(ledger.has("m:3")).toBe(true);
      vi.advanceTimersByTime(1_001);
      expect(ledger.has("m:3")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
