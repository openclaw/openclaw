import { describe, expect, it } from "vitest";
import {
  createQuotaNativeAuthObserver,
  quotaPublicDiagnostics,
  quotaRequestMode,
} from "./quota-reset-diagnostics.mjs";

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
        `codex app-server stderr: failed to connect to websocket: HTTP error: 401 Unauthorized, url: https://${secret}\n` +
        `codex app-server stderr: failed to connect to websocket: ${secret}\n` +
        `unrelated prompt: failed to connect to websocket: HTTP error: 418 ${secret}`,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toEqual({
      schemaVersion: 2,
      omitted: {
        requests: 0,
        upgrades: 0,
        refreshes: 0,
        nativeAuth: 0,
        responses: 0,
        handshakeFailures: 0,
      },
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
        {
          atMs: 5,
          kind: "refresh",
          method: "account/chatgptAuthTokens/refresh",
          reason: "unauthorized",
        },
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
    const result = quotaPublicDiagnostics({
      profile: { status: secret, expiresAt: secret, remainingMs: Infinity },
      requests: [{ atMs: secret, phase: secret, transport: secret, path: secret }],
      authEvents: [
        { atMs: Number.NaN, kind: "oauth-token", caller: secret },
        { atMs: Infinity, kind: "native-refresh", reason: secret },
        { kind: secret },
      ],
      responses: [
        {
          atMs: secret,
          status: secret,
          phase: secret,
          path: secret,
          mode: secret,
          transport: secret,
        },
      ],
      nativeLog: undefined,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.profile).toEqual({ status: "unknown", expiresAt: null, remainingMs: null });
    expect(result.requests).toEqual([
      { atMs: null, phase: "other", transport: "unknown", endpoint: "other" },
    ]);
    expect(result.refreshes).toEqual([{ atMs: null }]);
    expect(result.nativeAuth).toEqual([
      {
        atMs: null,
        kind: "refresh",
        method: "account/chatgptAuthTokens/refresh",
        reason: "unknown",
      },
    ]);
    expect(result.responses).toEqual([
      {
        atMs: null,
        phase: "other",
        transport: "unknown",
        endpoint: "other",
        status: null,
        statusClass: "unknown",
        mode: "unknown",
      },
    ]);
    expect(result.nativeLogAvailable).toBe(false);
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
      nativeLog:
        "codex app-server stderr: failed to connect to websocket: HTTP error: 401\n".repeat(140),
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
    expect(result.omitted).toEqual({
      requests: 12,
      upgrades: 12,
      refreshes: 12,
      nativeAuth: 12,
      responses: 12,
      handshakeFailures: 12,
    });
  });

  it("recognizes split native refresh frames without leaking IDs, tokens, or unrelated messages", () => {
    const events: unknown[] = [];
    const observe = createQuotaNativeAuthObserver((event) => events.push(event));
    const secret = "PRIVATE_NATIVE_CANARY";
    const frame =
      JSON.stringify({
        id: secret,
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: secret, token: secret },
      }) + "\n";
    observe(Buffer.from(frame.slice(0, 30)));
    expect(events).toEqual([]);
    observe(Buffer.from(frame.slice(30)));
    observe(
      `${JSON.stringify({ method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized" } })}\n`,
    );
    observe(`${JSON.stringify({ id: 1, method: secret, result: secret })}\n`);
    observe(`${secret}\nnull\n`);
    observe(
      `${JSON.stringify({ id: 2, method: "account/chatgptAuthTokens/refresh", params: { reason: secret } })}\n`,
    );
    expect(events).toEqual([
      { kind: "native-refresh", reason: "unauthorized" },
      { kind: "native-refresh", reason: "unknown" },
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("discards an oversized native line and resumes at the next complete frame", () => {
    const events: unknown[] = [];
    const observe = createQuotaNativeAuthObserver((event) => events.push(event));
    observe("x".repeat(1024 * 1024));
    observe("x");
    observe('"method":"account/chatgptAuthTokens/refresh","id":1}\n');
    observe(
      '{"method":"account/chatgptAuthTokens/refresh","id":2,"params":{"reason":"unauthorized"}}\n',
    );
    expect(events).toEqual([{ kind: "native-refresh", reason: "unauthorized" }]);
  });

  it.each([
    ['{"type":"response.create","generate":false}', "warmup"],
    ['{"type":"response.create","generate":true}', "inference"],
    ['{"type":"response.create"}', "inference"],
    ['{"input":"PRIVATE_PROMPT"}', "unknown"],
    ["PRIVATE_INVALID_JSON", "unknown"],
  ])("classifies only synthetic request mode", (body, expected) => {
    expect(quotaRequestMode(body)).toBe(expected);
  });
});
