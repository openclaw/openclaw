import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSlackHttpRequest,
  normalizeSlackWebhookPath,
  registerSlackHttpHandler,
} from "./registry.js";

const SIGNING_SECRET = "test-signing-secret-abc123";
const NOW_S = Math.floor(Date.now() / 1000);

function freshTimestamp(): string {
  return String(NOW_S);
}

function makeSignature(secret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

describe("normalizeSlackWebhookPath", () => {
  it("returns the default path when input is empty", () => {
    expect(normalizeSlackWebhookPath()).toBe("/slack/events");
    expect(normalizeSlackWebhookPath(" ")).toBe("/slack/events");
  });

  it("ensures a leading slash", () => {
    expect(normalizeSlackWebhookPath("slack/events")).toBe("/slack/events");
    expect(normalizeSlackWebhookPath("/hooks/slack")).toBe("/hooks/slack");
  });
});

describe("registerSlackHttpHandler", () => {
  const unregisters: Array<() => void> = [];

  afterEach(() => {
    for (const unregister of unregisters.splice(0)) {
      unregister();
    }
  });

  it("routes requests to a registered handler", async () => {
    const handler = vi.fn();
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events",
        handler,
      }),
    );

    const req = { url: "/slack/events?foo=bar" } as IncomingMessage;
    const res = {} as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith(req, res);
  });

  it("returns false when no handler matches", async () => {
    const req = { url: "/slack/other" } as IncomingMessage;
    const res = {} as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(false);
  });

  it("dispatches without signingSecret (no pre-check)", async () => {
    const handler = vi.fn();
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/open",
        handler,
        // no signingSecret — handler is responsible for its own auth
      }),
    );

    const req = { url: "/slack/open", headers: {} } as IncomingMessage;
    const res = {} as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith(req, res);
  });

  it("pre-rejects requests with missing timestamp header when signingSecret is configured", async () => {
    const handler = vi.fn();
    const writeHead = vi.fn();
    const end = vi.fn();
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events-signed",
        handler,
        signingSecret: SIGNING_SECRET,
      }),
    );

    const req = {
      url: "/slack/events-signed",
      headers: {
        // intentionally missing x-slack-request-timestamp
        "x-slack-signature": "v0=fake",
      },
    } as unknown as IncomingMessage;
    const res = { writeHead, end } as unknown as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(writeHead).toHaveBeenCalledWith(400, { "Content-Type": "text/plain" });
    expect(end).toHaveBeenCalledWith(expect.stringMatching(/Timestamp/i));
  });

  it("pre-rejects requests with missing signature header when signingSecret is configured", async () => {
    const handler = vi.fn();
    const writeHead = vi.fn();
    const end = vi.fn();
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events-signed2",
        handler,
        signingSecret: SIGNING_SECRET,
      }),
    );

    const req = {
      url: "/slack/events-signed2",
      headers: {
        "x-slack-request-timestamp": freshTimestamp(),
        // intentionally missing x-slack-signature
      },
    } as unknown as IncomingMessage;
    const res = { writeHead, end } as unknown as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(writeHead).toHaveBeenCalledWith(400, { "Content-Type": "text/plain" });
  });

  it("pre-rejects requests with a stale timestamp when signingSecret is configured", async () => {
    const handler = vi.fn();
    const writeHead = vi.fn();
    const end = vi.fn();
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events-signed3",
        handler,
        signingSecret: SIGNING_SECRET,
      }),
    );

    const staleTimestamp = String(NOW_S - 6 * 60); // 6 minutes ago
    const body = "{}";
    const sig = makeSignature(SIGNING_SECRET, staleTimestamp, body);

    const req = {
      url: "/slack/events-signed3",
      headers: {
        "x-slack-request-timestamp": staleTimestamp,
        "x-slack-signature": sig,
      },
    } as unknown as IncomingMessage;
    const res = { writeHead, end } as unknown as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(writeHead).toHaveBeenCalledWith(400, { "Content-Type": "text/plain" });
    expect(end).toHaveBeenCalledWith(expect.stringMatching(/timestamp/i));
  });

  it("forwards to handler when timestamp is fresh (HMAC verified by handler)", async () => {
    const handler = vi.fn();
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events-signed4",
        handler,
        signingSecret: SIGNING_SECRET,
      }),
    );

    const ts = freshTimestamp();
    const body = '{"type":"event_callback"}';
    const sig = makeSignature(SIGNING_SECRET, ts, body);

    const req = {
      url: "/slack/events-signed4",
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sig,
      },
    } as unknown as IncomingMessage;
    const res = {} as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith(req, res);
  });

  it("logs and ignores duplicate registrations", async () => {
    const handler = vi.fn();
    const log = vi.fn();
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events",
        handler,
        log,
        accountId: "primary",
      }),
    );
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events",
        handler: vi.fn(),
        log,
        accountId: "duplicate",
      }),
    );

    const req = { url: "/slack/events" } as IncomingMessage;
    const res = {} as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith(req, res);
    expect(log).toHaveBeenCalledWith(
      'slack: webhook path /slack/events already registered for account "duplicate"',
    );
  });
});
