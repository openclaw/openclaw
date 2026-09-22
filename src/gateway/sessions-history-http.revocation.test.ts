/**
 * HTTP session history revocation tests.
 */
import { EventEmitter } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

let transcriptUpdateHandler:
  | ((update: { sessionFile?: string; message?: unknown; messageId?: string }) => void)
  | undefined;
let authRevoked = false;
let gatewayConfig: {
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
} = {
  trustedProxies: ["10.0.0.1"],
  allowRealIpFallback: false,
};
let authCheckCalls = 0;
let transcriptReadError: Error | undefined;
let authenticatedUserProfile:
  | { profileId: string; displayName: string | null; hasAvatar: boolean; updatedAt: number }
  | undefined;
let sessionVisibleToProfile = true;
let currentSessionId = "session-1";
let currentLifecycleRevision = "before-reset";
let currentSessionStartedAt = 1;
let beforeHistoryReadReturns: (() => Promise<void>) | undefined;
let beforeHistoryRefreshReturns: (() => Promise<void>) | undefined;
let beforeAuthCheckReturns: (() => Promise<void>) | undefined;

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    gateway: gatewayConfig,
  }),
}));

vi.mock("../sessions/transcript-events.js", async (importOriginal) => {
  const {
    attachSessionTranscriptRunId,
    readSessionTranscriptUpdateVersion,
    resolveTerminalAssistantTranscriptRunId,
  } = await importOriginal<typeof import("../sessions/transcript-events.js")>();
  return {
    attachSessionTranscriptRunId,
    readSessionTranscriptUpdateVersion,
    resolveTerminalAssistantTranscriptRunId,
    onInternalSessionTranscriptUpdate: (cb: typeof transcriptUpdateHandler) => {
      transcriptUpdateHandler = cb;
      return () => {
        if (transcriptUpdateHandler === cb) {
          transcriptUpdateHandler = undefined;
        }
      };
    },
  };
});

vi.mock("./http-utils.js", () => ({
  getHeader: (req: IncomingMessage, name: string) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  },
  resolveSharedSecretHttpOperatorScopes: () => ["operator.read"],
  authorizeScopedGatewayHttpRequestOrReply: async () => ({
    cfg: { gateway: {} },
    requestAuth: {
      trustDeclaredOperatorScopes: true,
      ...(authenticatedUserProfile ? { authenticatedUserProfile } : {}),
    },
    operatorScopes: ["operator.read"],
  }),
  checkGatewayHttpRequestAuth: async (params: {
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
  }) => {
    authCheckCalls += 1;
    await beforeAuthCheckReturns?.();
    if (authRevoked) {
      return {
        ok: false as const,
        authResult: { ok: false, reason: "trusted_proxy_user_not_allowed" },
      };
    }
    if (
      gatewayConfig.trustedProxies === undefined &&
      gatewayConfig.allowRealIpFallback === undefined
    ) {
      return params.trustedProxies === undefined && params.allowRealIpFallback === undefined
        ? {
            ok: false as const,
            authResult: { ok: false, reason: "trusted_proxy_no_proxies_configured" },
          }
        : {
            ok: true as const,
            requestAuth: { trustDeclaredOperatorScopes: true },
          };
    }
    return {
      ok: true as const,
      requestAuth: {
        trustDeclaredOperatorScopes: true,
        ...(authenticatedUserProfile ? { authenticatedUserProfile } : {}),
      },
    };
  },
}));

vi.mock("./session-sharing.js", () => ({
  createSessionListEntryFilter: ({ client }: { client: unknown }) =>
    client ? () => sessionVisibleToProfile : undefined,
  resolveSessionSharingTarget: () => ({
    canonicalKey: "agent:main",
    agentId: "main",
    entry: {
      sessionId: currentSessionId,
      lifecycleRevision: currentLifecycleRevision,
      sessionStartedAt: currentSessionStartedAt,
    },
    storePath: "/tmp",
  }),
}));

vi.mock("./session-utils.js", () => ({
  resolveGatewaySessionStoreTargetWithStore: () => ({
    storePath: "/tmp",
    storeKeys: ["agent:main"],
    canonicalKey: "agent:main",
    agentId: "main",
    store: {},
  }),
  resolveCanonicalSessionEntryFromStoreKeys: () => ({
    sessionId: "session-1",
    lifecycleRevision: currentLifecycleRevision,
    sessionStartedAt: currentSessionStartedAt,
    sessionFile: "/tmp/session-1.jsonl",
  }),
  resolveSessionTranscriptCandidates: () => ["/tmp/session-1.jsonl"],
}));

vi.mock("./session-history-state.js", () => ({
  readSessionHistorySnapshotAsync: async () => {
    if (transcriptReadError) {
      throw transcriptReadError;
    }
    await beforeHistoryReadReturns?.();
    return {
      history: { items: [], nextCursor: null, messages: [] },
      rawTranscriptSeq: 0,
      turnBoundaryPending: false,
      assistantErrorPending: false,
    };
  },
  SessionHistorySseState: {
    fromSnapshot: (_params: unknown) => ({
      snapshot: () => ({ items: [], nextCursor: null, messages: [] }),
      retainRecentMessages: () => ({ items: [], nextCursor: null, messages: [] }),
      appendInlineMessage: ({ message, messageId }: { message: unknown; messageId?: string }) => ({
        message,
        messageSeq: 1,
        messageId,
      }),
      shouldRefreshForTranscriptPath: () => false,
      refreshAsync: async () => {
        await beforeHistoryRefreshReturns?.();
        return {
          items: [],
          nextCursor: null,
          messages: [{ role: "assistant", content: "private refreshed history" }],
        };
      },
    }),
  },
}));

import { createDeferred } from "../../test/helpers/promise.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-accessor.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { handleSessionHistoryHttpRequest } from "./sessions-history-http.js";

const SESSION_HISTORY_URL = "/sessions/agent%3Amain/history";
const SESSION_FILE = "/tmp/session-1.jsonl";
const TRUSTED_PROXY_STARTUP_OPTIONS = {
  auth: { mode: "trusted-proxy" } as never,
  trustedProxies: ["10.0.0.1"],
  allowRealIpFallback: false,
} satisfies Parameters<typeof handleSessionHistoryHttpRequest>[2];

class MockReq extends EventEmitter {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket = new EventEmitter();

  constructor(url: string) {
    super();
    this.url = url;
    this.method = "GET";
    this.headers = {
      host: "localhost",
      accept: "text/event-stream",
      authorization: "Bearer token",
      "x-openclaw-scopes": "operator.read",
    };
  }
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headers = new Map<string, string>();
  writes: string[] = [];
  writableEnded = false;
  socket = new EventEmitter();
  closeOnFrame?: "retry" | "history";

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string) {
    this.writes.push(chunk);
    const written = this.writes.join("");
    const closeMarker = this.closeOnFrame === "retry" ? "retry:" : "event: history";
    if (this.closeOnFrame && written.includes(closeMarker) && written.endsWith("\n\n")) {
      this.closeOnFrame = undefined;
      this.emit("close");
    }
    return true;
  }

  end(chunk?: string) {
    if (chunk !== undefined) {
      this.writes.push(chunk);
    }
    this.writableEnded = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }

  flushHeaders() {}
}

async function openSessionHistoryStream(
  options: Parameters<typeof handleSessionHistoryHttpRequest>[2],
) {
  return (await openSessionHistoryStreamPair(options)).res;
}

async function openSessionHistoryStreamPair(
  options: Parameters<typeof handleSessionHistoryHttpRequest>[2],
  params?: { closeOnFrame?: "retry" | "history"; expectSubscribed?: boolean },
) {
  const req = new MockReq(SESSION_HISTORY_URL);
  const res = new MockRes();
  res.closeOnFrame = params?.closeOnFrame;

  const handled = await handleSessionHistoryHttpRequest(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    options,
  );

  expect(handled).toBe(true);
  if (params?.closeOnFrame === "history" || params?.expectSubscribed !== false) {
    await vi.waitFor(() => expect(res.writes.join("")).toContain("event: history"));
  }
  if (params?.expectSubscribed === false) {
    expect(transcriptUpdateHandler).toBeUndefined();
  } else {
    expect(transcriptUpdateHandler).toBeTypeOf("function");
  }

  return { req, res };
}

async function withRealNodeSessionHistoryStream(
  run: (pair: { req: IncomingMessage; res: ServerResponse }) => Promise<void>,
) {
  const { promise: pairPromise, resolve: resolvePair } = createDeferred<{
    req: IncomingMessage;
    res: ServerResponse;
  }>();
  const {
    promise: handledPromise,
    resolve: resolveHandled,
    reject: rejectHandled,
  } = createDeferred<boolean>();
  const server = createServer((req, res) => {
    resolvePair({ req, res });
    void handleSessionHistoryHttpRequest(req, res, TRUSTED_PROXY_STARTUP_OPTIONS).then(
      resolveHandled,
      rejectHandled,
    );
  });

  await new Promise<void>((resolve, reject) => {
    const handleListenError = (error: Error) => reject(error);
    server.once("error", handleListenError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleListenError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP test server address");
  }

  const clientResponsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    const clientRequest = request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: SESSION_HISTORY_URL,
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer token",
          "x-openclaw-scopes": "operator.read",
        },
      },
      resolve,
    );
    clientRequest.once("error", reject);
    clientRequest.end();
  });

  const pair = await pairPromise;
  const clientResponse = await clientResponsePromise;
  clientResponse.resume();
  expect(await handledPromise).toBe(true);
  expect(transcriptUpdateHandler).toBeTypeOf("function");

  try {
    await run(pair);
  } finally {
    clientResponse.destroy();
    pair.res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function emitErrorOnNextTick(emitter: EventEmitter, error: Error): Promise<void> {
  return new Promise((resolve, reject) => {
    process.nextTick(() => {
      try {
        emitter.emit("error", error);
        resolve();
      } catch (emitError) {
        reject(emitError instanceof Error ? emitError : new Error(String(emitError)));
      }
    });
  });
}

function emitTranscriptTextUpdate({
  sessionFile = SESSION_FILE,
  text,
  messageId,
}: {
  sessionFile?: string;
  text: string;
  messageId: string;
}) {
  transcriptUpdateHandler?.({
    sessionFile,
    message: { role: "assistant", content: [{ type: "text", text }] },
    messageId,
  });
}

async function expectStreamClosedWithoutMessage(res: MockRes, text: string) {
  await vi.waitFor(() => {
    expect(res.writableEnded).toBe(true);
  });

  const joined = res.writes.join("");
  expect(joined).not.toContain("event: message");
  expect(joined).not.toContain(text);
  expect(res.writableEnded).toBe(true);
}

afterEach(() => {
  transcriptUpdateHandler = undefined;
  authRevoked = false;
  authCheckCalls = 0;
  transcriptReadError = undefined;
  authenticatedUserProfile = undefined;
  sessionVisibleToProfile = true;
  currentSessionId = "session-1";
  currentLifecycleRevision = "before-reset";
  currentSessionStartedAt = 1;
  beforeHistoryReadReturns = undefined;
  beforeHistoryRefreshReturns = undefined;
  beforeAuthCheckReturns = undefined;
  gatewayConfig = {
    trustedProxies: ["10.0.0.1"],
    allowRealIpFallback: false,
  };
});

describe("session history SSE auth revocation", () => {
  it("returns not found when a verified role cannot view the requested session", async () => {
    authenticatedUserProfile = {
      profileId: "profile-guest",
      displayName: "Guest",
      hasAvatar: false,
      updatedAt: 1,
    };
    sessionVisibleToProfile = false;

    const { res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS, {
      expectSubscribed: false,
    });

    expect(res.statusCode).toBe(404);
    expect(res.writes.join("")).toContain("Session not found");
  });

  it.each([
    { accept: "application/json", change: "revocation" },
    { accept: "text/event-stream", change: "revocation" },
    { accept: "application/json", change: "replacement" },
    { accept: "text/event-stream", change: "replacement" },
    { accept: "application/json", change: "reset" },
    { accept: "text/event-stream", change: "reset" },
    { accept: "application/json", change: "authentication" },
    { accept: "text/event-stream", change: "authentication" },
  ] as const)(
    "withholds initial $accept history after $change during its read",
    async ({ accept, change }) => {
      authenticatedUserProfile = {
        profileId: "profile-guest",
        displayName: "Guest",
        hasAvatar: false,
        updatedAt: 1,
      };
      const entered = createDeferred();
      const release = createDeferred();
      beforeHistoryReadReturns = async () => {
        entered.resolve();
        await release.promise;
      };
      const req = new MockReq(SESSION_HISTORY_URL);
      req.headers.accept = accept;
      const res = new MockRes();
      const pending = handleSessionHistoryHttpRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        TRUSTED_PROXY_STARTUP_OPTIONS,
      );
      try {
        await Promise.race([entered.promise, pending]);
        expect(res.writes).toEqual([]);
        if (change === "revocation") {
          sessionVisibleToProfile = false;
        } else if (change === "replacement") {
          currentSessionId = "replacement";
        } else if (change === "reset") {
          currentLifecycleRevision = "after-reset";
          currentSessionStartedAt = 2;
        } else {
          authRevoked = true;
        }
      } finally {
        release.resolve();
        await pending;
      }
      try {
        expect(res.statusCode).toBe(404);
        expect(res.writes.join("")).not.toContain("event: history");
        expect(res.writes.join("")).not.toContain('"messages"');
        expect(transcriptUpdateHandler).toBeUndefined();
      } finally {
        res.end();
      }
    },
  );

  it.each(["revocation", "replacement", "reset", "authentication"] as const)(
    "withholds an SSE refresh after %s while its read is pending",
    async (change) => {
      if (change === "revocation") {
        authenticatedUserProfile = {
          profileId: "profile-guest",
          displayName: "Guest",
          hasAvatar: false,
          updatedAt: 1,
        };
      }
      const res = await openSessionHistoryStream(TRUSTED_PROXY_STARTUP_OPTIONS);
      const entered = createDeferred();
      const release = createDeferred();
      beforeHistoryRefreshReturns = async () => {
        entered.resolve();
        await release.promise;
      };
      transcriptUpdateHandler?.({ sessionFile: SESSION_FILE });
      try {
        await entered.promise;
        if (change === "revocation") {
          sessionVisibleToProfile = false;
        } else if (change === "replacement") {
          currentSessionId = "replacement";
        } else if (change === "reset") {
          currentLifecycleRevision = "after-reset";
          currentSessionStartedAt = 2;
        } else {
          authRevoked = true;
        }
      } finally {
        release.resolve();
      }
      try {
        await expectStreamClosedWithoutMessage(res, "private refreshed history");
        expect(res.writes.filter((frame) => frame.includes("event: history"))).toHaveLength(1);
        expect(transcriptUpdateHandler).toBeUndefined();
      } finally {
        res.end();
      }
    },
  );

  it("closes an existing stream before disclosure when profile access is revoked", async () => {
    authenticatedUserProfile = {
      profileId: "profile-guest",
      displayName: "Guest",
      hasAvatar: false,
      updatedAt: 1,
    };
    const res = await openSessionHistoryStream(TRUSTED_PROXY_STARTUP_OPTIONS);
    sessionVisibleToProfile = false;

    emitTranscriptTextUpdate({ text: "role-revoked secret", messageId: "m-role" });

    await expectStreamClosedWithoutMessage(res, "role-revoked secret");
  });

  it("keeps inline delivery between coalesced refreshes while authorization is pending", async () => {
    const res = await openSessionHistoryStream(TRUSTED_PROXY_STARTUP_OPTIONS);
    const entered = createDeferred();
    const release = createDeferred();
    let refreshCount = 0;
    beforeAuthCheckReturns = async () => {
      entered.resolve();
      await release.promise;
    };
    beforeHistoryRefreshReturns = async () => {
      refreshCount++;
    };
    try {
      transcriptUpdateHandler?.({ sessionFile: SESSION_FILE });
      await entered.promise;
      transcriptUpdateHandler?.({ sessionFile: SESSION_FILE });
      emitTranscriptTextUpdate({ text: "inline between refreshes", messageId: "inline-barrier" });
      transcriptUpdateHandler?.({ sessionFile: SESSION_FILE });
      transcriptUpdateHandler?.({ sessionFile: SESSION_FILE });
      release.resolve();

      await vi.waitFor(() =>
        expect(res.writes.filter((frame) => frame.includes("event: history"))).toHaveLength(3),
      );
      expect(refreshCount).toBe(2);
      expect(
        res.writes
          .filter((frame) => frame.startsWith("event:"))
          .map((frame) => frame.split("\n")[0]),
      ).toEqual(["event: history", "event: history", "event: message", "event: history"]);
      expect(res.writes.join("")).toContain("inline between refreshes");
    } finally {
      release.resolve();
      res.end();
    }
  });

  it("returns retryable HTTP unavailable while a dirty projection rebuilds", async () => {
    transcriptReadError = new SessionTranscriptProjectionUnavailableError("session-1");

    const { req, res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS, {
      expectSubscribed: false,
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.writes.join("")).toContain('"retryable":true');
    expect(req.listenerCount("error")).toBe(0);
  });

  it.each([
    { code: "overloaded", message: "session history is busy; retry shortly" },
    { code: "unavailable", message: "session history is temporarily unavailable; retry shortly" },
    { code: "timeout", message: "session history read timed out; retry shortly" },
  ] as const)(
    "returns retryable HTTP unavailable when a history worker is $code",
    async ({ code, message }) => {
      transcriptReadError = new WorkerTaskError("internal worker failure detail", code);

      const { req, res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS, {
        expectSubscribed: false,
      });

      expect(res.statusCode).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(JSON.parse(res.writes.join(""))).toEqual({
        ok: false,
        error: { type: "unavailable", message, retryable: true },
      });
      expect(req.listenerCount("error")).toBe(0);
    },
  );

  it("preserves unexpected HTTP history worker failures for the request error owner", async () => {
    const failure = new WorkerTaskError("unexpected worker task failure", "failed");
    transcriptReadError = failure;
    const req = new MockReq(SESSION_HISTORY_URL);
    const res = new MockRes();

    await expect(
      handleSessionHistoryHttpRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        TRUSTED_PROXY_STARTUP_OPTIONS,
      ),
    ).rejects.toBe(failure);
    expect(res.writes).toEqual([]);
    expect(transcriptUpdateHandler).toBeUndefined();
  });

  it("closes the stream before delivering transcript updates after auth is revoked", async () => {
    const res = await openSessionHistoryStream({ auth: { mode: "trusted-proxy" } as never });

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    authRevoked = true;

    emitTranscriptTextUpdate({
      text: "post-revocation secret",
      messageId: "m-1",
    });

    await expectStreamClosedWithoutMessage(res, "post-revocation secret");
  });

  it("rechecks SSE auth against live proxy config instead of startup fallbacks", async () => {
    const res = await openSessionHistoryStream(TRUSTED_PROXY_STARTUP_OPTIONS);

    gatewayConfig = {};

    emitTranscriptTextUpdate({
      text: "stale-proxy event",
      messageId: "m-2",
    });

    await expectStreamClosedWithoutMessage(res, "stale-proxy event");
  });

  it("skips SSE reauth for transcript updates outside this stream", async () => {
    const res = await openSessionHistoryStream(TRUSTED_PROXY_STARTUP_OPTIONS);

    authCheckCalls = 0;
    gatewayConfig = {};

    emitTranscriptTextUpdate({
      sessionFile: "/tmp/other-session.jsonl",
      text: "other session",
      messageId: "m-3",
    });

    const joined = res.writes.join("");
    expect(authCheckCalls).toBe(0);
    expect(joined).not.toContain("other session");
    expect(res.writableEnded).toBe(false);
  });

  it("closes and cleans up the SSE stream when the request stream emits an error", async () => {
    const { req, res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS);

    expect(() => req.emit("error", new Error("request stream failed"))).not.toThrow();

    expect(res.writableEnded).toBe(true);
    expect(transcriptUpdateHandler).toBeUndefined();
    expect(req.listenerCount("error")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });

  it("cleans up SSE resources when the response stream emits an error", async () => {
    const { req, res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS);

    expect(() => res.emit("error", new Error("response stream failed"))).not.toThrow();

    expect(transcriptUpdateHandler).toBeUndefined();
    expect(req.listenerCount("error")).toBe(1);
    expect(res.listenerCount("error")).toBe(1);

    emitTranscriptTextUpdate({
      text: "post-response-error update",
      messageId: "m-response-error",
    });
    expect(res.writes.join("")).not.toContain("post-response-error update");

    res.emit("close");
    expect(req.listenerCount("error")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });

  it("keeps real Node stream errors handled while a request failure ends the response", async () => {
    await withRealNodeSessionHistoryStream(async ({ req, res }) => {
      expect(req.listenerCount("error")).toBeGreaterThan(0);
      expect(res.listenerCount("error")).toBeGreaterThan(0);

      expect(() => req.emit("error", new Error("request stream failed"))).not.toThrow();
      expect(res.writableEnded).toBe(true);

      await expect(
        emitErrorOnNextTick(res, new Error("response failed during end flush")),
      ).resolves.toBeUndefined();
    });
  });

  it("keeps real Node response errors handled until the ended response closes", async () => {
    await withRealNodeSessionHistoryStream(async ({ res }) => {
      expect(() => res.emit("error", new Error("response stream failed"))).not.toThrow();
      expect(transcriptUpdateHandler).toBeUndefined();

      res.end();

      await expect(
        emitErrorOnNextTick(res, new Error("response failed after end")),
      ).resolves.toBeUndefined();
    });
  });

  it.each(["retry", "history"] as const)(
    "cleans up SSE resources when the initial %s frame closes the stream",
    async (closeOnFrame) => {
      const { req, res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS, {
        closeOnFrame,
        expectSubscribed: false,
      });

      expect(res.writes.join("")).toContain("retry: 1000\n\n");
      expect(transcriptUpdateHandler).toBeUndefined();
      expect(req.listenerCount("error")).toBe(0);
      expect(res.listenerCount("error")).toBe(0);
    },
  );
});
