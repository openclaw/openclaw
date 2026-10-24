// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import {
  TerminalConnection,
  type TerminalGatewayClient,
  TerminalOpenTimeoutError,
  TerminalOpenUnusableSessionError,
} from "./terminal-connection.ts";

type TerminalSink = Parameters<TerminalConnection["open"]>[1];
type TerminalOpenParams = Parameters<TerminalConnection["open"]>[0];
type TestSessionResult = {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  confined: boolean;
  buffer?: string;
  seq?: number;
  title?: string;
};

function sessionResult(overrides: Partial<TestSessionResult> = {}): TestSessionResult {
  return {
    sessionId: "s1",
    agentId: "main",
    shell: "/bin/zsh",
    cwd: "/work",
    confined: false,
    ...overrides,
  };
}

/** Fake gateway client that records requests and lets tests push events. */
function makeFakeClient() {
  const listeners = new Set<(evt: { event: string; payload: unknown }) => void>();
  const requests: Array<{
    method: string;
    params: unknown;
    options?: { timeoutMs?: number | null };
  }> = [];
  const forceReconnects: string[] = [];
  const client: TerminalGatewayClient & {
    requests: typeof requests;
    emit: (event: string, payload: unknown) => void;
    listenerCount: () => number;
    forceReconnects: string[];
    nextResponse: unknown;
  } = {
    requests,
    nextResponse: sessionResult(),
    forceReconnects,
    request: <T>(method: string, params?: unknown, options?: { timeoutMs?: number | null }) => {
      requests.push({ method, params, ...(options ? { options } : {}) });
      return Promise.resolve(client.nextResponse as T);
    },
    addEventListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event, payload) => {
      for (const l of listeners) {
        l({ event, payload });
      }
    },
    forceReconnect: (reason) => forceReconnects.push(reason),
    listenerCount: () => listeners.size,
  };
  return client;
}

type FakeClient = ReturnType<typeof makeFakeClient>;

let client: FakeClient;
let conn: TerminalConnection;
let data: string[];
let replays: string[];
let exits: unknown[];
let sink: TerminalSink;
beforeEach(() => {
  client = makeFakeClient();
  conn = new TerminalConnection(client);
  data = [];
  replays = [];
  exits = [];
  sink = testSink({
    onReplay: ({ data: snapshot }) => {
      replays.push(snapshot);
    },
  });
});
afterEach(() => vi.useRealTimers());
function expectRetired() {
  expect(conn.size).toBe(0);
  expect(client.listenerCount()).toBe(0);
}
function testSink(overrides: Partial<TerminalSink> = {}): TerminalSink {
  const onData = overrides.onData ?? ((chunk: string) => data.push(chunk));
  return {
    onData,
    onReplay: ({ data: snapshot }) => onData(snapshot),
    onExit: (info) => exits.push(info),
    ...overrides,
  };
}

function openSession(
  overrides: Partial<TerminalSink> = {},
  params: Partial<TerminalOpenParams> = {},
) {
  return conn.open({ cols: 80, rows: 24, ...params }, testSink(overrides));
}

function emitData(seq: number, chunk: string, sessionId = "s1"): void {
  client.emit("terminal.data", { sessionId, seq, data: chunk });
}

function emitExit(
  info: { exitCode: number | null; signal: number | null; reason?: string },
  sessionId = "s1",
): void {
  client.emit("terminal.exit", { sessionId, ...info });
}

function deferRequest<T>(method: string, pending: ReturnType<typeof createDeferred<T>>): void {
  const baseRequest = client.request.bind(client);
  client.request = (<R>(
    candidate: string,
    params?: unknown,
    options?: { timeoutMs?: number | null },
  ): Promise<R> => {
    if (candidate === method) {
      client.requests.push({ method: candidate, params, ...(options ? { options } : {}) });
      return pending.promise as unknown as Promise<R>;
    }
    return baseRequest<R>(candidate, params, options);
  }) as typeof client.request;
}

describe("TerminalConnection", () => {
  // The gateway creates the session before answering, so a response that cannot
  // drive a tab must not simply throw: the live server session would keep its
  // slot against the connection cap with nothing able to close it.
  it("closes the opened session when the response omits shell", async () => {
    const { shell: _dropped, ...incomplete } = sessionResult();
    client.nextResponse = incomplete;

    await expect(openSession()).rejects.toBeInstanceOf(TerminalOpenUnusableSessionError);

    expect(client.requests.map((request) => request.method)).toEqual([
      "terminal.open",
      "terminal.close",
    ]);
    expect(client.requests[1]?.params).toEqual({ sessionId: "s1" });
  });

  it("repairs a sequence gap with one authoritative attach replay", async () => {
    const snapshots: Array<{ snapshot: string; newlyObservedFrom: number }> = [];
    const recovery = createDeferred<TestSessionResult>();
    await openSession({
      onReplay: ({ data: snapshot, newlyObservedFrom }) => {
        snapshots.push({ snapshot, newlyObservedFrom });
      },
    });
    deferRequest("terminal.attach", recovery);

    emitData(0, "nope", "other");
    expect(data).toEqual([]);
    emitData(5, "hello");
    // startOfChunk=7, but expected=5. The missing bytes are already in the ring.
    emitData(12, "world");
    // This frame races before the server takes its attach snapshot. It must be
    // covered by replay, not rendered twice or treated as another gap.
    emitData(19, "covered");
    emitExit({ exitCode: null, signal: null, reason: "detached" });
    recovery.resolve(sessionResult({ buffer: "hello??worldcovered", seq: 19 }));

    await vi.waitFor(() =>
      expect(snapshots).toEqual([{ snapshot: "hello??worldcovered", newlyObservedFrom: 5 }]),
    );
    expect(data).toEqual(["hello"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      1,
    );

    emitData(20, "!");
    expect(data).toEqual(["hello", "!"]);
    expect(exits).toEqual([]);
    expect(conn.size).toBe(1);
  });

  it("does not let a superseded recovery drain the replacement stream queue", async () => {
    const oldReplay = createDeferred();
    const oldReplayEvents: string[] = [];
    let oldReplaySignal: AbortSignal | undefined;
    await openSession({
      onData: () => {},
      onReplay: async ({ signal }) => {
        oldReplaySignal = signal;
        oldReplayEvents.push("start");
        await oldReplay.promise;
        oldReplayEvents.push("done");
      },
    });
    client.nextResponse = sessionResult({ buffer: "old snapshot", seq: 12 });
    emitData(5, "hello");
    emitData(12, "world");
    await vi.waitFor(() => expect(oldReplayEvents).toEqual(["start"]));
    expect(oldReplaySignal?.aborted).toBe(false);

    const newReplay = createDeferred();
    const newReplayEvents: string[] = [];
    const newData: string[] = [];
    client.nextResponse = sessionResult({ buffer: "new snapshot", seq: 20 });
    const newAttach = conn.attach("s1", {
      onData: (chunk) => newData.push(chunk),
      onReplay: async () => {
        newReplayEvents.push("start");
        await newReplay.promise;
        newReplayEvents.push("done");
      },
      onExit: () => {},
    });
    await vi.waitFor(() => expect(newReplayEvents).toEqual(["start"]));
    expect(oldReplaySignal?.aborted).toBe(true);
    emitData(21, "!");

    oldReplay.resolve();
    await vi.waitFor(() => expect(oldReplayEvents).toEqual(["start", "done"]));
    await Promise.resolve();
    newReplay.resolve();
    await newAttach;

    expect(newReplayEvents).toEqual(["start", "done"]);
    expect(newData).toEqual(["!"]);
  });

  it("retries an unapplied resume suffix after its replay fails", async () => {
    const output: string[] = [];
    let replayFailed = false;
    await openSession({
      onData: (chunk) => output.push(chunk),
      onReplay: ({ data: snapshot, newlyObservedFrom }) => {
        if (!replayFailed) {
          replayFailed = true;
          throw new Error("emulator unavailable");
        }
        output.push(snapshot.slice(newlyObservedFrom));
      },
    });
    emitData(5, "hello");
    conn.suspend();
    client.nextResponse = sessionResult({ buffer: "helloagain", seq: 10 });
    expect((await conn.resume()).has("s1")).toBe(true);
    expect(output.join("")).toBe("hello");

    conn.suspend();
    expect((await conn.resume()).size).toBe(0);
    emitData(11, "!");
    expect(output.join("")).toBe("helloagain!");
    conn.dispose();
  });

  it("delivers the received tail and exit when recovery loses the finished session", async () => {
    await openSession(sink);
    const recovery = createDeferred<never>();
    deferRequest("terminal.attach", recovery);

    emitData(5, "hello");
    emitData(12, "world");
    emitData(13, "!");
    emitExit({ exitCode: 0, signal: null });
    recovery.reject(new Error("unknown terminal session"));

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(data).toEqual(["hello", "world", "!"]);
    expect(client.forceReconnects).toEqual([]);
    expect(conn.size).toBe(0);
  });

  it("keeps a queued exit behind recovery started while flushing early events", async () => {
    const openResult = createDeferred<TestSessionResult>();
    const recovery = createDeferred<TestSessionResult>();
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      return method === "terminal.open" ? openResult.promise : recovery.promise;
    }) as typeof client.request;
    const opening = openSession(sink);
    emitData(7, "first");
    emitExit({ exitCode: 0, signal: null });
    openResult.resolve(sessionResult());
    await opening;
    expect(exits).toEqual([]);

    recovery.resolve(sessionResult({ buffer: "complete output", seq: 7 }));

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(replays).toEqual(["complete output"]);
    expect(conn.size).toBe(0);
  });

  it("reconnects when the browser watchdog cannot receive the Gateway deadline", async () => {
    client.request = <T>(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number | null },
    ) => {
      client.requests.push({ method, params, ...(options ? { options } : {}) });
      return Promise.reject(
        new Error(`gateway request timed out after ${options?.timeoutMs}ms: ${method}`),
      ) as Promise<T>;
    };
    await expect(openSession()).rejects.toBeInstanceOf(TerminalOpenTimeoutError);
    expect(client.forceReconnects).toEqual(["terminal open watchdog timeout"]);
  });

  it("marks the session unavailable when resize rejects its live owner", async () => {
    await openSession(sink);
    client.nextResponse = { ok: false };

    await conn.resize("s1", 120, 40);

    expect(exits).toEqual([
      {
        exitCode: null,
        signal: null,
        reason: "disconnected",
        error: "Terminal session is no longer available. Open a new terminal session.",
      },
    ]);
    expectRetired();
  });

  it.each(["terminal.input", "terminal.resize"] as const)(
    "reports rejected and unconfirmed %s delivery without retiring the session",
    async (method) => {
      await openSession(sink);
      const act = () =>
        method === "terminal.input" ? conn.input("s1", "typed") : conn.resize("s1", 120, 40);
      client.nextResponse = null;
      await expect(act()).rejects.toThrow("delivery could not be confirmed");
      const request = vi.spyOn(client, "request").mockRejectedValueOnce(new Error("offline"));
      await expect(act()).rejects.toThrow("offline");
      expect(conn.size).toBe(1);
      request.mockRestore();
      conn.dispose();
    },
  );

  it("buffers an instant exit that races ahead of registration", async () => {
    let exit: unknown;
    const opening = createDeferred<TestSessionResult>();
    deferRequest("terminal.open", opening);
    const openPromise = openSession({
      onExit: (info) => (exit = info),
    });
    // A shell that fails to exec exits before the client has a sink.
    emitData(4, "boom");
    emitExit({ exitCode: 127, signal: null, reason: "process_exit" });
    expect(exit).toBeUndefined();

    opening.resolve(sessionResult({ shell: "/bad/shell" }));
    await openPromise;
    expect(data).toEqual(["boom"]);
    expect(exit).toEqual({ exitCode: 127, signal: null, reason: "process_exit", error: undefined });
    // Replaying the early exit releases the session — no leaked sink/listener.
    expectRetired();
  });

  it("keeps the listener while an open is in flight even if every session closes", async () => {
    await openSession(sink);

    // Second open held in flight while the only registered session closes.
    const opening = createDeferred<TestSessionResult>();
    deferRequest("terminal.open", opening);
    const openPromise = openSession({ onData: (chunk) => data.push(chunk) });

    await conn.close("s1");
    // The in-flight open must keep the subscription so s2's early output
    // is buffered instead of silently lost.
    expect(client.listenerCount()).toBe(1);
    emitData(5, "early", "s2");

    opening.resolve(sessionResult({ sessionId: "s2" }));
    await openPromise;
    expect(data).toEqual(["early"]);
  });

  it("drops the final exit the server emits while a close RPC is in flight", async () => {
    await openSession(sink);
    // A second session keeps the event subscription alive across the close.
    client.nextResponse = sessionResult({ sessionId: "s2" });
    await openSession();

    // The server finalizes the session (emitting terminal.exit) before it
    // responds to terminal.close, so the event arrives with no sink.
    const baseRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === "terminal.close") {
        emitExit({ exitCode: null, signal: null, reason: "closed" });
      }
      return baseRequest(method, params);
    }) as typeof client.request;
    await conn.close("s1");

    // If that exit were buffered, reusing the id would replay it into the new
    // session's sink and instantly mark a live tab as exited.
    client.nextResponse = sessionResult();
    let staleExit = false;
    await openSession({
      onExit: () => {
        staleExit = true;
      },
    });
    expect(staleExit).toBe(false);
    expect(conn.size).toBe(2);
  });

  it("orders early, replay-pending, and live attach output without replaying a stale detach", async () => {
    const replay = createDeferred();
    const attached = createDeferred<TestSessionResult>();
    deferRequest("terminal.attach", attached);
    const order: string[] = [];
    const attachPromise = conn.attach(
      "s1",
      testSink({
        onData: (chunk) => order.push(`data:${chunk}`),
        onReplay: async ({ data: snapshot, mode }) => {
          order.push(`${mode}:${snapshot}`);
          await replay.promise;
          order.push("replay:done");
        },
      }),
    );
    emitData(21, " tail");
    emitExit({ exitCode: null, signal: null, reason: "detached" });
    expect(order).toEqual([]);
    attached.resolve(sessionResult({ buffer: "replayed history", seq: 16 }));
    await vi.waitFor(() => expect(order).toEqual(["initial:replayed history"]));
    emitData(26, " live");
    expect(order).toEqual(["initial:replayed history"]);
    replay.resolve();
    expect((await attachPromise).buffer).toBe("replayed history");
    expect(client.requests[0]).toEqual({ method: "terminal.attach", params: { sessionId: "s1" } });
    emitData(27, "!");
    expect(order).toEqual([
      "initial:replayed history",
      "replay:done",
      "data: tail",
      "data: live",
      "data:!",
    ]);
    expect(exits).toEqual([]);
    expect(conn.size).toBe(1);
  });
  it("rejects initial replay failures without retaining a stream", async () => {
    client.nextResponse = sessionResult({ buffer: "snapshot", seq: 8 });

    let replaySignal: AbortSignal | undefined;
    await expect(
      conn.attach("s1", {
        onData: () => {},
        onReplay: async ({ signal }) => {
          replaySignal = signal;
          throw new Error("replay failed");
        },
        onExit: () => {},
      }),
    ).rejects.toThrow("replay failed");
    expect(replaySignal?.aborted).toBe(true);
    expectRetired();
  });

  it.each(["buffer", "seq"] as const)(
    "rejects an unusable replay missing %s without retaining its event listener",
    async (field) => {
      const { [field]: _dropped, ...incomplete } = sessionResult({ buffer: "snapshot", seq: 8 });
      client.nextResponse = incomplete;

      await expect(conn.attach("s1", testSink())).rejects.toBeInstanceOf(
        TerminalOpenUnusableSessionError,
      );
      expectRetired();
    },
  );

  it("lists attachable sessions and tolerates a missing sessions field", async () => {
    const info = {
      ...sessionResult(),
      attached: false,
      createdAtMs: 1,
    };
    client.nextResponse = { sessions: [info] };
    expect(await conn.list()).toEqual([info]);
    client.nextResponse = {};
    expect(await conn.list()).toEqual([]);
  });

  it("retains an active stream and pending input while Gateway application responses are delayed", async () => {
    vi.useFakeTimers();
    const onData = vi.fn();
    const onExit = vi.fn();
    await openSession({ onData, onExit });

    const response = createDeferred<{ ok: boolean }>();
    deferRequest("terminal.input", response);
    const baseRequest = client.request.bind(client);
    client.request = <T>(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number | null },
    ): Promise<T> => {
      const timeoutMs = options?.timeoutMs;
      if (timeoutMs != null) {
        client.requests.push({ method, params, options });
        return new Promise<T>((_, reject) => {
          setTimeout(() => reject(new Error("Gateway application response timed out")), timeoutMs);
        });
      }
      return baseRequest<T>(method, params, options);
    };

    let settled = false;
    const input = conn.input("s1", "echo ready\n").then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.forceReconnects).toEqual([]);
      expect(onExit).not.toHaveBeenCalled();
      expect(conn.size).toBe(1);
      expect(client.listenerCount()).toBe(1);
      expect(settled).toBe(false);

      response.resolve({ ok: true });
      await input;
      expect(settled).toBe(true);
      emitData(6, "ready\n");
      expect(onData).toHaveBeenCalledExactlyOnceWith("ready\n");
    } finally {
      response.resolve({ ok: true });
      await input;
      conn.dispose();
    }
  });

  // A reply after panel teardown must not retain a sink or event subscription.
  it.each([
    ["attach", "terminal.attach"],
    ["open", "terminal.open"],
  ] as const)(
    "a late %s reply after dispose() leaves no resurrected stream or listener",
    async (kind, method) => {
      const response = createDeferred<TestSessionResult & { buffer: string }>();
      deferRequest(method, response);
      const settle =
        kind === "attach"
          ? conn.attach("s1", testSink())
          : conn.open({ cols: 80, rows: 24 }, testSink());
      // Panel teardown (reconnect or element removal) discards the connection
      // while the RPC is still in flight.
      conn.dispose();
      response.resolve({ ...sessionResult(), buffer: "replayed\n", seq: 9 });
      await expect(settle).resolves.toMatchObject({ sessionId: "s1" });
      expectRetired();
    },
  );
});
