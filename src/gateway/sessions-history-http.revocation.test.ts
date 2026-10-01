import { EventEmitter, once } from "node:events";
import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";

class FixtureState {
  onUpdate?: (update: InternalSessionTranscriptUpdate) => void;
  authRevoked = false;
  authorityCurrent = true;
  gatewayConfig: { trustedProxies?: string[]; allowRealIpFallback?: boolean } = {
    trustedProxies: ["10.0.0.1"],
    allowRealIpFallback: false,
  };
  authChecks = 0;
  readError?: Error;
  profile?: typeof guestProfile;
  visible = true;
  sessionId = "session-1";
  lifecycleRevision = "before-reset";
  sessionStartedAt = 1;
  beforeRead?: () => Promise<void>;
  beforeRefresh?: () => Promise<void>;
  beforeAuth?: () => Promise<void>;
}
let fixture = new FixtureState();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({ gateway: fixture.gatewayConfig }),
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
    onInternalSessionTranscriptUpdate: (cb: typeof fixture.onUpdate) => {
      fixture.onUpdate = cb;
      return () => {
        if (fixture.onUpdate === cb) {
          fixture.onUpdate = undefined;
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
      hasCurrentClientAuthority: () => fixture.authorityCurrent,
      ...(fixture.profile ? { authenticatedUserProfile: fixture.profile } : {}),
    },
    operatorScopes: ["operator.read"],
  }),
  checkGatewayHttpRequestAuth: async (params: {
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
  }) => {
    fixture.authChecks += 1;
    await fixture.beforeAuth?.();
    const unconfigured =
      fixture.gatewayConfig.trustedProxies === undefined &&
      fixture.gatewayConfig.allowRealIpFallback === undefined;
    if (
      fixture.authRevoked ||
      (unconfigured &&
        params.trustedProxies === undefined &&
        params.allowRealIpFallback === undefined)
    ) {
      return {
        ok: false as const,
        authResult: {
          ok: false,
          reason: fixture.authRevoked
            ? "trusted_proxy_user_not_allowed"
            : "trusted_proxy_no_proxies_configured",
        },
      };
    }
    return {
      ok: true as const,
      requestAuth: {
        trustDeclaredOperatorScopes: true,
        ...(!unconfigured && fixture.profile ? { authenticatedUserProfile: fixture.profile } : {}),
      },
    };
  },
}));

vi.mock("./session-sharing.js", () => ({
  createSessionListEntryFilter: ({ client }: { client: unknown }) =>
    client ? () => fixture.visible : undefined,
  resolveSessionSharingTarget: () => ({
    canonicalKey: "agent:main",
    agentId: "main",
    entry: {
      sessionId: fixture.sessionId,
      lifecycleRevision: fixture.lifecycleRevision,
      sessionStartedAt: fixture.sessionStartedAt,
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
    lifecycleRevision: fixture.lifecycleRevision,
    sessionStartedAt: fixture.sessionStartedAt,
    sessionFile: "/tmp/session-1.jsonl",
  }),
  resolveSessionTranscriptCandidates: () => ["/tmp/session-1.jsonl"],
}));

vi.mock("./session-history-state.js", () => ({
  readSessionHistorySnapshotAsync: async () => {
    if (fixture.readError) {
      throw fixture.readError;
    }
    await fixture.beforeRead?.();
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
        await fixture.beforeRefresh?.();
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

const guestProfile = {
  profileId: "profile-guest",
  displayName: "Guest",
  hasAvatar: false,
  updatedAt: 1,
};
const SESSION_HISTORY_URL = "/sessions/agent%3Amain/history";
const SESSION_FILE = "/tmp/session-1.jsonl";
const TRUSTED_PROXY_STARTUP_OPTIONS = {
  auth: { mode: "trusted-proxy" } as never,
  trustedProxies: ["10.0.0.1"],
  allowRealIpFallback: false,
} satisfies Parameters<typeof handleSessionHistoryHttpRequest>[2];

class MockReq extends EventEmitter {
  url = SESSION_HISTORY_URL;
  method = "GET";
  socket = new EventEmitter();
  headers: Record<string, string> = {
    host: "localhost",
    accept: "text/event-stream",
    authorization: "Bearer token",
    "x-openclaw-scopes": "operator.read",
  };
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headers = new Map<string, string>();
  writes: string[] = [];
  writableEnded = false;
  socket = new EventEmitter();
  closeOnRetry?: boolean;

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string) {
    this.writes.push(chunk);
    const written = this.writes.join("");
    if (this.closeOnRetry && written.includes("retry:") && written.endsWith("\n\n")) {
      this.closeOnRetry = false;
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

function readBarrier() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered,
    release,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}

function handle(req: MockReq, res: MockRes) {
  return handleSessionHistoryHttpRequest(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    TRUSTED_PROXY_STARTUP_OPTIONS,
  );
}

async function openStream(params: { closeOnRetry?: boolean; expectSubscribed?: boolean } = {}) {
  const req = new MockReq();
  const res = new MockRes();
  res.closeOnRetry = params.closeOnRetry;
  expect(await handle(req, res)).toBe(true);
  if (params.expectSubscribed === false) {
    expect(fixture.onUpdate).toBeUndefined();
  } else {
    await vi.waitFor(() => expect(res.writes.join("")).toContain("event: history"));
    expect(fixture.onUpdate).toBeTypeOf("function");
  }
  return { req, res };
}

async function withRealStream(
  run: (pair: { req: IncomingMessage; res: ServerResponse }) => Promise<void>,
) {
  const connected = createDeferred<{ req: IncomingMessage; res: ServerResponse }>();
  const handled = createDeferred<boolean>();
  const server = createServer((req, res) => {
    connected.resolve({ req, res });
    void handleSessionHistoryHttpRequest(req, res, TRUSTED_PROXY_STARTUP_OPTIONS).then(
      handled.resolve,
      handled.reject,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP test server address");
  }
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    get(
      `http://127.0.0.1:${address.port}${SESSION_HISTORY_URL}`,
      {
        headers: new MockReq().headers,
      },
      resolve,
    ).once("error", reject);
  });
  const pair = await connected.promise;
  const client = await response;
  client.resume();
  expect(await handled.promise).toBe(true);
  expect(fixture.onUpdate).toBeTypeOf("function");
  try {
    await run(pair);
  } finally {
    client.destroy();
    pair.res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
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

function emitTranscriptTextUpdate(
  text: string,
  update: Partial<Pick<InternalSessionTranscriptUpdate, "sessionFile" | "target">> = {},
) {
  fixture.onUpdate?.({
    sessionFile: SESSION_FILE,
    target: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main",
      storePath: "/tmp",
    },
    lifecycleRevision: "before-reset",
    message: { role: "assistant", content: [{ type: "text", text }] },
    messageId: "message-1",
    messageSeq: 1,
    ...update,
  });
}

async function expectStreamClosedWithoutMessage(res: MockRes, text: string) {
  await vi.waitFor(() => expect(res.writableEnded).toBe(true));

  expect(res.writes.join("")).not.toContain("event: message");
  expect(res.writes.join("")).not.toContain(text);
}

afterEach(() => {
  fixture = new FixtureState();
});

describe("session history SSE auth revocation", () => {
  it("returns not found when a verified role cannot view the requested session", async () => {
    fixture.profile = guestProfile;
    fixture.visible = false;

    const { res } = await openStream({
      expectSubscribed: false,
    });

    expect(res.statusCode).toBe(404);
    expect(res.writes.join("")).toContain("Session not found");
  });

  it.each([
    { accept: "application/json", change: "revocation" },
    { accept: "text/event-stream", change: "replacement" },
    { accept: "application/json", change: "reset" },
    { accept: "text/event-stream", change: "authentication" },
    { accept: "application/json", change: "ingress policy" },
  ] as const)(
    "withholds initial $accept history after $change during its read",
    async ({ accept, change }) => {
      fixture.profile = guestProfile;
      const { entered, release, wait } = readBarrier();
      fixture.beforeRead = wait;
      const req = new MockReq();
      req.headers.accept = accept;
      const res = new MockRes();
      const pending = handle(req, res);
      try {
        await Promise.race([entered.promise, pending]);
        expect(res.writes).toEqual([]);
        if (change === "revocation") {
          fixture.visible = false;
        } else if (change === "replacement") {
          fixture.sessionId = "replacement";
        } else if (change === "reset") {
          fixture.lifecycleRevision = "after-reset";
          fixture.sessionStartedAt = 2;
        } else if (change === "ingress policy") {
          fixture.authorityCurrent = false;
        } else {
          fixture.authRevoked = true;
        }
      } finally {
        release.resolve();
        await pending;
      }
      try {
        expect(res.statusCode).toBe(404);
        expect(res.writes.join("")).not.toContain("event: history");
        expect(res.writes.join("")).not.toContain('"messages"');
        expect(fixture.onUpdate).toBeUndefined();
      } finally {
        res.end();
      }
    },
  );

  it("withholds an SSE refresh after profile revocation while its read is pending", async () => {
    fixture.profile = guestProfile;
    const { res } = await openStream();
    const barrier = readBarrier();
    fixture.beforeRefresh = barrier.wait;
    fixture.onUpdate?.({ sessionFile: SESSION_FILE });
    try {
      await barrier.entered.promise;
      fixture.visible = false;
    } finally {
      barrier.release.resolve();
    }
    try {
      await expectStreamClosedWithoutMessage(res, "private refreshed history");
      expect(res.writes.filter((frame) => frame.includes("event: history"))).toHaveLength(1);
      expect(fixture.onUpdate).toBeUndefined();
    } finally {
      res.end();
    }
  });

  it("closes an existing stream before disclosure when profile access is revoked", async () => {
    fixture.profile = guestProfile;
    const { res } = await openStream();
    fixture.visible = false;

    emitTranscriptTextUpdate("role-revoked secret");

    await expectStreamClosedWithoutMessage(res, "role-revoked secret");
  });

  it("keeps inline delivery between coalesced refreshes while authorization is pending", async () => {
    const { res } = await openStream();
    const { entered, release, wait } = readBarrier();
    let refreshCount = 0;
    fixture.beforeAuth = wait;
    fixture.beforeRefresh = async () => {
      refreshCount++;
    };
    try {
      fixture.onUpdate?.({ sessionFile: SESSION_FILE });
      await entered.promise;
      fixture.onUpdate?.({ sessionFile: SESSION_FILE });
      emitTranscriptTextUpdate("inline between refreshes");
      fixture.onUpdate?.({ sessionFile: SESSION_FILE });
      fixture.onUpdate?.({ sessionFile: SESSION_FILE });
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

  it.each([
    {
      name: "projection rebuilding",
      error: new SessionTranscriptProjectionUnavailableError("session-1"),
      message: "session history is rebuilding; retry shortly",
    },
    {
      name: "worker overload",
      error: new WorkerTaskError("internal worker failure detail", "overloaded"),
      message: "session history is busy; retry shortly",
    },
  ])("returns retryable HTTP unavailable during $name", async ({ error, message }) => {
    fixture.readError = error;
    const { req, res } = await openStream({ expectSubscribed: false });
    expect(res.statusCode).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(JSON.parse(res.writes.join(""))).toEqual({
      ok: false,
      error: { type: "unavailable", message, retryable: true },
    });
    expect(req.listenerCount("error")).toBe(0);
  });

  it("rechecks SSE auth against live proxy config instead of startup fallbacks", async () => {
    const { res } = await openStream();

    fixture.gatewayConfig = {};

    emitTranscriptTextUpdate("stale-proxy event");

    await expectStreamClosedWithoutMessage(res, "stale-proxy event");
  });

  it("skips SSE reauth for transcript updates outside this stream", async () => {
    const { res } = await openStream();

    fixture.authChecks = 0;
    fixture.gatewayConfig = {};

    emitTranscriptTextUpdate("other session", {
      sessionFile: "/tmp/other-session.jsonl",
      target: {
        agentId: "main",
        sessionId: "other-session",
        sessionKey: "agent:main:other",
        storePath: "/tmp",
      },
    });

    const joined = res.writes.join("");
    expect(fixture.authChecks).toBe(0);
    expect(joined).not.toContain("other session");
    expect(res.writableEnded).toBe(false);
  });

  it.each(["request", "response"] as const)(
    "handles late real Node response errors after a %s failure",
    async (source) => {
      await withRealStream(async ({ req, res }) => {
        expect(req.listenerCount("error")).toBeGreaterThan(0);
        expect(res.listenerCount("error")).toBeGreaterThan(0);
        expect(() =>
          (source === "request" ? req : res).emit("error", new Error("stream failed")),
        ).not.toThrow();
        expect(fixture.onUpdate).toBeUndefined();
        if (source === "request") {
          expect(res.writableEnded).toBe(true);
        } else {
          res.end();
        }
        await expect(
          emitErrorOnNextTick(res, new Error("response failed after end")),
        ).resolves.toBeUndefined();
      });
    },
  );

  it("cleans up SSE resources when the initial retry frame closes the stream", async () => {
    const { req, res } = await openStream({ closeOnRetry: true, expectSubscribed: false });
    expect(res.writes.join("")).toContain("retry: 1000\n\n");
    expect(fixture.onUpdate).toBeUndefined();
    expect(req.listenerCount("error")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });
});
