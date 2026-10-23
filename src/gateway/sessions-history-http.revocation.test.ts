import { EventEmitter, once } from "node:events";
import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";

const history = (messages: unknown[] = []) => ({ items: [], nextCursor: null, messages });

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
  beforeInline?: () => Promise<void>;
}
let fixture = new FixtureState();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({ gateway: fixture.gatewayConfig }),
}));

vi.mock("../sessions/transcript-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessions/transcript-events.js")>();
  return {
    ...actual,
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

// mock-isolation: Drive explicit auth revocation gates without consulting live HTTP auth state.
vi.mock("./http-utils.js", () => ({
  getHeader: (req: IncomingMessage, name: string) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  },
  resolveSharedSecretHttpOperatorScopes: () => ["operator.read"],
  authorizeScopedGatewayHttpRequestOrReply: async () => ({
    cfg: { gateway: {} },
    requestAuth: {
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
    const reason = fixture.authRevoked
      ? "trusted_proxy_user_not_allowed"
      : unconfigured &&
          params.trustedProxies === undefined &&
          params.allowRealIpFallback === undefined
        ? "trusted_proxy_no_proxies_configured"
        : undefined;
    if (reason) {
      return { ok: false as const, authResult: { ok: false, reason } };
    }
    return {
      ok: true as const,
      requestAuth:
        !unconfigured && fixture.profile ? { authenticatedUserProfile: fixture.profile } : {},
    };
  },
}));

// mock-isolation: HTTP history fixtures control visibility and target replacement during awaited reads.
vi.mock("./session-sharing.js", () => ({
  prepareProjectedSessionSharing: ({ client }: { client: unknown }) => ({
    entryFilter: client ? () => fixture.visible : undefined,
  }),
}));

// mock-isolation: Revocation tests retain synthetic mutation facts without admitting a physical store.
vi.mock("./session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: async () => ({
    storageTarget: { agentId: "main", canonicalKey: "agent:main:main", storePath: "/tmp" },
    prepareRead: () => undefined,
    readCurrent: () => ({
      target: {
        agentId: "main",
        canonicalKey: "agent:main:main",
        storeKey: "agent:main:main",
        storeKeys: ["agent:main:main"],
        storePath: "/tmp",
        entry: {
          sessionId: fixture.sessionId,
          lifecycleRevision: fixture.lifecycleRevision,
          sessionStartedAt: fixture.sessionStartedAt,
        },
      },
    }),
    release() {},
  }),
}));

// mock-isolation: History fixtures resolve synthetic transcript paths and current entries without disk lookup.
vi.mock("./session-utils.js", () => ({
  resolveSessionTranscriptCandidates: () => ["/tmp/session-1.jsonl"],
}));

// mock-isolation: Hold refresh and inline payload admission in memory without opening a transcript store.
vi.mock("./session-history-state.js", () => ({
  readSessionHistorySnapshotAsync: async () => {
    if (fixture.readError) {
      throw fixture.readError;
    }
    await fixture.beforeRead?.();
    return { history: history() };
  },
  SessionHistorySseState: {
    fromSnapshot: () => ({
      snapshot: () => history(),
      retainRecentMessages() {},
      prepareInlineMessage: async ({
        message,
        messageId,
      }: {
        message: unknown;
        messageId?: string;
      }) => {
        await fixture.beforeInline?.();
        return () => ({ message, messageSeq: 1, messageId });
      },
      shouldRefreshForTranscriptPath: () => false,
      refreshAsync: async () => {
        await fixture.beforeRefresh?.();
        return history([{ role: "assistant", content: "private refreshed history" }]);
      },
    }),
  },
}));

import { createDeferred } from "../../test/helpers/promise.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-accessor.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { handleSessionHistoryHttpRequest } from "./sessions-history-http.js";

const guestProfile = { profileId: "profile-guest" };
const SESSION_HISTORY_URL = "/sessions/agent%3Amain%3Amain/history";
const SESSION_FILE = "/tmp/session-1.jsonl";
const TRUSTED_PROXY_STARTUP_OPTIONS = {
  auth: { mode: "trusted-proxy" } as never,
  trustedProxies: ["10.0.0.1"],
  allowRealIpFallback: false,
} satisfies Parameters<typeof handleSessionHistoryHttpRequest>[2];

class MockReq extends EventEmitter {
  url = SESSION_HISTORY_URL;
  method = "GET";
  headers = { accept: "text/event-stream" };
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headers = new Map<string, string>();
  writes: string[] = [];
  writableEnded = false;
  closeOnRetry?: boolean;

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string) {
    this.writes.push(chunk);
    this.emit("write", chunk);
    if (this.closeOnRetry && chunk.includes("retry:") && chunk.endsWith("\n\n")) {
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

  [Symbol.dispose]() {
    this.end();
  }
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
    [Symbol.dispose]: () => release.resolve(),
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
  const initial =
    params.expectSubscribed === false ? undefined : waitForFrame(res, "event: history");
  expect(await handle(req, res)).toBe(true);
  if (params.expectSubscribed === false) {
    expect(fixture.onUpdate).toBeUndefined();
  } else {
    await initial;
    expect(fixture.onUpdate).toBeTypeOf("function");
  }
  return Object.assign(res, { req });
}

function waitForFrame(res: MockRes, text: string): Promise<void> {
  return new Promise((resolve) => {
    const onWrite = (chunk: string) => {
      if (chunk.includes(text)) {
        res.off("write", onWrite);
        resolve();
      }
    };
    res.on("write", onWrite);
  });
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
    const url = `http://127.0.0.1:${address.port}${SESSION_HISTORY_URL}`;
    get(url, { headers: new MockReq().headers }, resolve).once("error", reject);
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
      sessionKey: "agent:main:main",
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

beforeEach(() => setRuntimeConfigSnapshot({ gateway: fixture.gatewayConfig }));

const frames = (res: MockRes) => res.writes.filter((frame) => frame.startsWith("event:"));
const frameNames = (res: MockRes) =>
  frames(res).map((frame) => frame.split("\n")[0]?.replace(/^event: /, ""));
const changes = {
  revocation: { visible: false },
  sharing: { visible: false },
  replacement: { sessionId: "replacement" },
  reset: { lifecycleRevision: "after-reset" },
  "ingress policy": { authorityCurrent: false },
  authentication: { authRevoked: true },
  close: {},
  failure: {},
};

afterEach(() => {
  fixture = new FixtureState();
  clearRuntimeConfigSnapshot();
});

it("returns not found when a verified role cannot view the requested session", async () => {
  fixture.profile = guestProfile;
  fixture.visible = false;

  using res = await openStream({ expectSubscribed: false });

  expect(res.statusCode).toBe(404);
  expect(res.writes.join("")).toContain("Session not found");
});

it.each([
  ["application/json", "revocation"],
  ["text/event-stream", "replacement"],
  ["application/json", "reset"],
  ["text/event-stream", "authentication"],
  ["application/json", "ingress policy"],
] as const)("withholds initial %s history after %s during its read", async (accept, change) => {
  fixture.profile = guestProfile;
  using barrier = readBarrier();
  const { entered, release, wait } = barrier;
  fixture.beforeRead = wait;
  const req = new MockReq();
  req.headers.accept = accept;
  using res = new MockRes();
  const pending = handle(req, res);
  try {
    await Promise.race([entered.promise, pending]);
    expect(res.writes).toEqual([]);
    Object.assign(fixture, changes[change]);
    if (change === "reset") {
      fixture.sessionStartedAt = 2;
    }
  } finally {
    release.resolve();
    await pending;
  }
  expect(res.statusCode).toBe(404);
  expect(res.writes.join("")).not.toMatch(/event: history|"messages"/);
  expect(fixture.onUpdate).toBeUndefined();
});

it("withholds an SSE refresh after profile revocation while its read is pending", async () => {
  fixture.profile = guestProfile;
  using res = await openStream();
  using barrier = readBarrier();
  fixture.beforeRefresh = barrier.wait;
  fixture.onUpdate?.({ sessionFile: SESSION_FILE });
  await barrier.entered.promise;
  fixture.visible = false;
  barrier.release.resolve();
  await expectStreamClosedWithoutMessage(res, "private refreshed history");
  expect(res.writes.filter((frame) => frame.includes("event: history"))).toHaveLength(1);
  expect(fixture.onUpdate).toBeUndefined();
});

it("keeps inline delivery between coalesced refreshes while authorization is pending", async () => {
  using res = await openStream();
  using barrier = readBarrier();
  let refreshCount = 0;
  fixture.beforeAuth = barrier.wait;
  fixture.beforeRefresh = async () => {
    refreshCount++;
  };
  fixture.onUpdate?.({ sessionFile: SESSION_FILE });
  await barrier.entered.promise;
  fixture.onUpdate?.({ sessionFile: SESSION_FILE });
  emitTranscriptTextUpdate("inline between refreshes");
  fixture.onUpdate?.({ sessionFile: SESSION_FILE });
  fixture.onUpdate?.({ sessionFile: SESSION_FILE });
  barrier.release.resolve();
  await vi.waitFor(() =>
    expect(frameNames(res)).toEqual(["history", "history", "message", "history"]),
  );
  expect(refreshCount).toBe(2);
  expect(res.writes.join("")).toContain("inline between refreshes");
});

it.each(["sharing", "replacement", "reset", "close", "failure"] as const)(
  "withholds a delayed inline message after %s",
  async (change) => {
    fixture.profile = guestProfile;
    using res = await openStream();
    using barrier = readBarrier();
    fixture.beforeInline = async () => {
      await barrier.wait();
      if (change === "failure") {
        throw new Error("inline visibility worker failed");
      }
    };
    const closed = once(res, "close");
    emitTranscriptTextUpdate("pending inline content");
    await barrier.entered.promise;
    Object.assign(fixture, changes[change]);
    if (change === "close") {
      res.end();
    }
    barrier.release.resolve();
    await closed;
    expect(res.writes.join("")).not.toContain("pending inline content");
    expect(fixture.onUpdate).toBeUndefined();
  },
);

it("serializes appends and trailing refreshes behind pending inline visibility", async () => {
  using res = await openStream();
  using barrier = readBarrier();
  fixture.beforeInline = barrier.wait;
  const refreshed = waitForFrame(res, "private refreshed history");
  emitTranscriptTextUpdate("first queued append");
  await barrier.entered.promise;
  emitTranscriptTextUpdate("second queued append");
  fixture.onUpdate?.({ sessionFile: SESSION_FILE });
  expect(frames(res)).toHaveLength(1);
  barrier.release.resolve();
  await refreshed;
  expect(frameNames(res)).toEqual(["history", "message", "message", "history"]);
  expect(frames(res)[1]).toContain("first queued append");
  expect(frames(res)[2]).toContain("second queued append");
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
  using res = await openStream({ expectSubscribed: false });
  expect(res.statusCode).toBe(503);
  expect(res.headers.get("retry-after")).toBe("1");
  expect(JSON.parse(res.writes.join(""))).toEqual({
    ok: false,
    error: { type: "unavailable", message, retryable: true },
  });
  expect(res.req.listenerCount("error")).toBe(0);
});

it("rechecks SSE auth against live proxy config instead of startup fallbacks", async () => {
  using res = await openStream();

  fixture.gatewayConfig = {};
  setRuntimeConfigSnapshot({ gateway: fixture.gatewayConfig });

  emitTranscriptTextUpdate("stale-proxy event");

  await expectStreamClosedWithoutMessage(res, "stale-proxy event");
});

it("skips SSE reauth for transcript updates outside this stream", async () => {
  using res = await openStream();

  fixture.authChecks = 0;
  fixture.gatewayConfig = {};
  setRuntimeConfigSnapshot({ gateway: fixture.gatewayConfig });

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

it("handles a request abort after the response closes until the request closes", async () => {
  using res = await openStream();
  const { req } = res;
  res.emit("close");
  expect(fixture.onUpdate).toBeUndefined();
  await expect(emitErrorOnNextTick(req, new Error("aborted"))).resolves.toBeUndefined();
  req.emit("close");
  expect(req.listenerCount("error")).toBe(0);
  expect(res.listenerCount("error")).toBe(0);
});

it("cleans up SSE resources when the initial retry frame closes the stream", async () => {
  using res = await openStream({ closeOnRetry: true, expectSubscribed: false });
  const { req } = res;
  expect(res.writes.join("")).toContain("retry: 1000\n\n");
  expect(fixture.onUpdate).toBeUndefined();
  req.emit("close");
  expect(req.listenerCount("error")).toBe(0);
  expect(res.listenerCount("error")).toBe(0);
});
