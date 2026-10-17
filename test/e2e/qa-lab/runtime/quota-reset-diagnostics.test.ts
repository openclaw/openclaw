import { describe, expect, it } from "vitest";
import {
  createQuotaNativeAuthObserver,
  quotaPublicDiagnostics,
  quotaRequestMode,
} from "./quota-reset-diagnostics.mjs";

const REFRESH = "account/chatgptAuthTokens/refresh";
const nativeRefresh = (atMs: number | null, reason: string) => ({
  atMs,
  kind: "refresh",
  method: REFRESH,
  reason,
});
const omitted = (count: number) => ({
  requests: count,
  upgrades: count,
  refreshes: count,
  nativeAuth: count,
  responses: count,
  handshakeFailures: count,
});
const nativeFrame = (id?: unknown, reason: unknown = "unauthorized", privateParams = {}) =>
  `${JSON.stringify({ id, method: REFRESH, params: { reason, ...privateParams } })}\n`;
const captureNativeAuth = () => {
  const events: unknown[] = [];
  return { events, observe: createQuotaNativeAuthObserver((event) => events.push(event)) };
};
const handshakeError = (detail: string) =>
  `codex app-server stderr: failed to connect to websocket: ${detail}\n`;

describe("quota public diagnostics", () => {
  it("publishes only health and transport facts when private evidence contains credentials", () => {
    const secret = "PRIVATE_CANARY_DO_NOT_PUBLISH";
    const result = quotaPublicDiagnostics({
      profile: { status: "expiring", expiresAt: 123, remainingMs: 45, access: secret },
      requests: [
        {
          atMs: 1,
          phase: "initial-exhaustion",
          transport: "websocket",
          path: `/private/${secret}/responses?token=${secret}`,
          headers: { authorization: secret },
          body: secret,
        },
      ],
      upgrades: [{ atMs: 2, path: `/v1/responses?token=${secret}`, headers: secret }],
      authEvents: [
        { atMs: 3, kind: "oauth-token", stack: secret, body: secret },
        { atMs: 4, kind: "native-observer", process: secret },
        { atMs: 5, kind: "native-refresh", reason: "unauthorized", params: secret },
      ],
      responses: [
        {
          atMs: 6,
          phase: "healthy",
          transport: "websocket",
          path: `/v1/responses?token=${secret}`,
          status: 401,
          mode: "inference",
          value: secret,
        },
      ],
      nativeLog:
        handshakeError(`HTTP error: 401 Unauthorized, url: https://${secret}`) +
        handshakeError(secret) +
        `unrelated prompt: failed to connect to websocket: HTTP error: 418 ${secret}`,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toEqual({
      schemaVersion: 2,
      omitted: omitted(0),
      refreshReceiptAvailable: true,
      authCaptureTruncated: false,
      nativeLogAvailable: true,
      profile: { status: "expiring", expiresAt: 123, remainingMs: 45 },
      requests: [
        { atMs: 1, phase: "initial-exhaustion", transport: "websocket", endpoint: "responses" },
      ],
      upgrades: [{ atMs: 2, endpoint: "responses" }],
      refreshes: [{ atMs: 3 }],
      nativeAuth: [
        { atMs: 4, kind: "observer-attached", method: null, reason: "unknown" },
        nativeRefresh(5, "unauthorized"),
      ],
      responses: [
        {
          atMs: 6,
          phase: "healthy",
          transport: "websocket",
          endpoint: "responses",
          status: 401,
          statusClass: "4xx",
          mode: "inference",
        },
      ],
      handshakeFailures: [
        { kind: "http", httpStatus: 401 },
        { kind: "unknown", httpStatus: null },
      ],
    });
  });

  it("keeps unavailable evidence and unknown fields explicit without copying input strings", () => {
    const secret = "PRIVATE_UNKNOWN_CANARY";
    const invalidTransport = { atMs: secret, phase: secret, transport: secret, path: secret };
    const result = quotaPublicDiagnostics({
      profile: { status: secret, expiresAt: secret, remainingMs: Infinity },
      requests: [invalidTransport],
      authEvents: [
        { atMs: Number.NaN, kind: "oauth-token", caller: secret },
        { atMs: Infinity, kind: "native-refresh", reason: secret },
        { kind: secret },
      ],
      responses: [{ ...invalidTransport, status: secret, mode: secret }],
      nativeLog: undefined,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    const unknownTransport = {
      atMs: null,
      phase: "other",
      transport: "unknown",
      endpoint: "other",
    };
    const { profile, requests, refreshes, nativeAuth, responses, nativeLogAvailable } = result;
    expect({ profile, requests, refreshes, nativeAuth, responses, nativeLogAvailable }).toEqual({
      profile: { status: "unknown", expiresAt: null, remainingMs: null },
      requests: [unknownTransport],
      refreshes: [{ atMs: null }],
      nativeAuth: [nativeRefresh(null, "unknown")],
      responses: [{ ...unknownTransport, status: null, statusClass: "unknown", mode: "unknown" }],
      nativeLogAvailable: false,
    });
    expect(quotaPublicDiagnostics({}).refreshReceiptAvailable).toBe(false);
  });

  it("bounds each diagnostic stream while retaining its latest facts", () => {
    const events = Array.from({ length: 140 }, (_, atMs) => ({ atMs }));
    const result = quotaPublicDiagnostics({
      requests: events,
      upgrades: events,
      authEvents: events
        .flatMap((event) => [
          { ...event, kind: "oauth-token" },
          { ...event, kind: "native-refresh" },
        ])
        .concat([{ atMs: 140, kind: "truncated" }]),
      responses: events,
      nativeLog: handshakeError("HTTP error: 401").repeat(140),
    });
    for (const stream of [
      result.requests,
      result.upgrades,
      result.refreshes,
      result.nativeAuth,
      result.responses,
    ]) {
      expect(stream).toHaveLength(128);
      expect(stream[0]?.atMs).toBe(12);
      expect(stream.at(-1)?.atMs).toBe(139);
    }
    expect(result.handshakeFailures).toHaveLength(128);
    expect(result.authCaptureTruncated).toBe(true);
    expect(result.omitted).toEqual(omitted(12));
  });

  it("recognizes split native refresh frames without leaking IDs, tokens, or unrelated messages", () => {
    const { events, observe } = captureNativeAuth();
    const secret = "PRIVATE_NATIVE_CANARY";
    const frame = nativeFrame(secret, "unauthorized", { previousAccountId: secret, token: secret });
    observe(Buffer.from(frame.slice(0, 30)));
    expect(events).toEqual([]);
    observe(Buffer.from(frame.slice(30)));
    observe(nativeFrame());
    observe(`${JSON.stringify({ id: 1, method: secret, result: secret })}\n`);
    observe(`${secret}\nnull\n`);
    observe(nativeFrame(2, secret));
    expect(events).toEqual([
      { kind: "native-refresh", reason: "unauthorized" },
      { kind: "native-refresh", reason: "unknown" },
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("discards an oversized native line and resumes at the next complete frame", () => {
    const { events, observe } = captureNativeAuth();
    observe("x".repeat(1024 * 1024));
    observe("x");
    observe('"method":"account/chatgptAuthTokens/refresh","id":1}\n');
    observe(nativeFrame(2));
    expect(events).toEqual([{ kind: "native-refresh", reason: "unauthorized" }]);
  });

  it.each([
    ['{"type":"response.create","generate":false}', "warmup"],
    ['{"type":"response.create"}', "inference"],
    ['{"input":"PRIVATE_PROMPT"}', "unknown"],
    ["PRIVATE_INVALID_JSON", "unknown"],
  ])("classifies only synthetic request mode", (body, expected) => {
    expect(quotaRequestMode(body)).toBe(expected);
  });
});
