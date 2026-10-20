// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
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

function makeHarness() {
  const client = makeFakeClient();
  return { client, conn: new TerminalConnection(client) };
}

function testSink(overrides: Partial<TerminalSink> = {}): TerminalSink {
  const onData = overrides.onData ?? (() => {});
  return {
    onData,
    onReplay: ({ data }) => onData(data),
    onExit: () => {},
    ...overrides,
  };
}

function openSession(
  conn: TerminalConnection,
  overrides: Partial<TerminalSink> = {},
  params: Partial<TerminalOpenParams> = {},
) {
  return conn.open({ cols: 80, rows: 24, ...params }, testSink(overrides));
}

function emitData(client: FakeClient, seq: number, data: string, sessionId = "s1"): void {
  client.emit("terminal.data", { sessionId, seq, data });
}

function emitExit(
  client: FakeClient,
  info: { exitCode: number | null; signal: number | null; reason?: string },
  sessionId = "s1",
): void {
  client.emit("terminal.exit", { sessionId, ...info });
}

function deferRequest<T>(
  client: FakeClient,
  method: string,
  pending: ReturnType<typeof createDeferred<T>>,
): void {
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

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

describe("TerminalConnection", () => {
  // The gateway creates the session before answering, so a response that cannot
  // drive a tab must not simply throw: the live server session would keep its
  // slot against the connection cap with nothing able to close it.
  it.each(["shell"] as const)(
    "closes the opened session when the response omits %s",
    async (field) => {
      const { client, conn } = makeHarness();
      const { [field]: _dropped, ...incomplete } = sessionResult();
      client.nextResponse = incomplete;

      await expect(openSession(conn)).rejects.toBeInstanceOf(TerminalOpenUnusableSessionError);

      expect(client.requests.map((request) => request.method)).toEqual([
        "terminal.open",
        "terminal.close",
      ]);
      expect(client.requests[1]?.params).toEqual({ sessionId: "s1" });
    },
  );

  it("repairs a sequence gap with one authoritative attach replay", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const replays: Array<{ snapshot: string; newlyObservedFrom: number }> = [];
    const recovery = createDeferred<TestSessionResult>();
    await openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onReplay: ({ data: snapshot, newlyObservedFrom }) => {
        replays.push({ snapshot, newlyObservedFrom });
      },
    });
    deferRequest(client, "terminal.attach", recovery);

    emitData(client, 5, "hello");
    // startOfChunk=7, but expected=5. The missing bytes are already in the ring.
    emitData(client, 12, "world");
    // This frame races before the server takes its attach snapshot. It must be
    // covered by replay, not rendered twice or treated as another gap.
    emitData(client, 19, "covered");
    recovery.resolve(sessionResult({ buffer: "hello??worldcovered", seq: 19 }));

    await vi.waitFor(() =>
      expect(replays).toEqual([{ snapshot: "hello??worldcovered", newlyObservedFrom: 5 }]),
    );
    expect(data).toEqual(["hello"]);
    expect(client.requests.filter((request) => request.method === "terminal.attach")).toHaveLength(
      1,
    );

    emitData(client, 20, "!");
    expect(data).toEqual(["hello", "!"]);
  });

  it("does not let a superseded recovery drain the replacement stream queue", async () => {
    const { client, conn } = makeHarness();
    const oldReplay = createDeferred();
    const oldReplayEvents: string[] = [];
    let oldReplaySignal: AbortSignal | undefined;
    await openSession(conn, {
      onData: () => {},
      onReplay: async ({ signal }) => {
        oldReplaySignal = signal;
        oldReplayEvents.push("start");
        await oldReplay.promise;
        oldReplayEvents.push("done");
      },
    });
    client.nextResponse = sessionResult({ buffer: "old snapshot", seq: 12 });
    emitData(client, 5, "hello");
    emitData(client, 12, "world");
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
    emitData(client, 21, "!");

    oldReplay.resolve();
    await vi.waitFor(() => expect(oldReplayEvents).toEqual(["start", "done"]));
    await Promise.resolve();
    newReplay.resolve();
    await newAttach;

    expect(newReplayEvents).toEqual(["start", "done"]);
    expect(newData).toEqual(["!"]);
  });

  it("retries an unapplied resume suffix after its replay fails", async () => {
    const { client, conn } = makeHarness();
    const output: string[] = [];
    let replayFailed = false;
    await openSession(conn, {
      onData: (data) => output.push(data),
      onReplay: ({ data, newlyObservedFrom }) => {
        if (!replayFailed) {
          replayFailed = true;
          throw new Error("emulator unavailable");
        }
        output.push(data.slice(newlyObservedFrom));
      },
    });
    emitData(client, 5, "hello");
    conn.suspend();
    client.nextResponse = sessionResult({ buffer: "helloagain", seq: 10 });
    expect((await conn.resume()).has("s1")).toBe(true);
    expect(output.join("")).toBe("hello");

    conn.suspend();
    expect((await conn.resume()).size).toBe(0);
    emitData(client, 11, "!");
    expect(output.join("")).toBe("helloagain!");
    conn.dispose();
  });

  it("discards a detached exit that predates a successful recovery rebind", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const replays: string[] = [];
    const exits: unknown[] = [];
    const recovery = createDeferred<TestSessionResult>();
    await openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onReplay: ({ data: snapshot }) => {
        replays.push(snapshot);
      },
      onExit: (info) => exits.push(info),
    });
    deferRequest(client, "terminal.attach", recovery);

    emitData(client, 5, "hello");
    emitData(client, 12, "world");
    emitExit(client, { exitCode: null, signal: null, reason: "detached" });
    recovery.resolve(sessionResult({ buffer: "complete output", seq: 12 }));

    await vi.waitFor(() => expect(replays).toEqual(["complete output"]));
    emitData(client, 13, "!");
    expect(data).toEqual(["hello", "!"]);
    expect(exits).toEqual([]);
    expect(conn.size).toBe(1);
  });

  it("delivers the received tail and exit when recovery loses the finished session", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const exits: unknown[] = [];
    const recovery = createDeferred<never>();
    await openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onReplay: () => {},
      onExit: (info) => exits.push(info),
    });
    deferRequest(client, "terminal.attach", recovery);

    emitData(client, 5, "hello");
    emitData(client, 12, "world");
    emitData(client, 13, "!");
    emitExit(client, { exitCode: 0, signal: null });
    recovery.reject(new Error("unknown terminal session"));

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(data).toEqual(["hello", "world", "!"]);
    expect(client.forceReconnects).toEqual([]);
    expect(conn.size).toBe(0);
  });

  it("keeps a queued exit behind recovery started while flushing early events", async () => {
    const { client, conn } = makeHarness();
    const openResult = createDeferred<TestSessionResult>();
    const recovery = createDeferred<TestSessionResult>();
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      return method === "terminal.open" ? openResult.promise : recovery.promise;
    }) as typeof client.request;
    const replays: string[] = [];
    const exits: unknown[] = [];

    const opening = openSession(conn, {
      onData: () => {},
      onReplay: ({ data: snapshot }) => {
        replays.push(snapshot);
      },
      onExit: (info) => exits.push(info),
    });
    emitData(client, 7, "first");
    emitExit(client, { exitCode: 0, signal: null });
    openResult.resolve(sessionResult());
    await opening;
    expect(exits).toEqual([]);

    recovery.resolve(sessionResult({ buffer: "complete output", seq: 7 }));

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(replays).toEqual(["complete output"]);
    expect(conn.size).toBe(0);
  });

  it("reconnects when the browser watchdog cannot receive the Gateway deadline", async () => {
    const { client, conn } = makeHarness();
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
    await expect(openSession(conn)).rejects.toBeInstanceOf(TerminalOpenTimeoutError);
    expect(client.forceReconnects).toEqual(["terminal open watchdog timeout"]);
  });

  it("does not deliver data to the wrong session", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    await openSession(conn, { onData: (dataChunk) => data.push(dataChunk) });
    emitData(client, 0, "nope", "other");
    expect(data).toEqual([]);
  });

  it.each([["terminal.resize", (conn: TerminalConnection) => conn.resize("s1", 120, 40)]] as const)(
    "marks the session unavailable when %s rejects its live owner",
    async (_, act) => {
      const { client, conn } = makeHarness();
      const exits: unknown[] = [];
      await openSession(conn, { onExit: (info) => exits.push(info) });
      client.nextResponse = { ok: false };

      await act(conn);

      expect(exits).toEqual([
        {
          exitCode: null,
          signal: null,
          reason: "disconnected",
          error: "Terminal session is no longer available. Open a new terminal session.",
        },
      ]);
      expect(conn.size).toBe(0);
      expect(client.listenerCount()).toBe(0);
    },
  );

  it.each(["terminal.input", "terminal.resize"] as const)(
    "reports rejected and unconfirmed %s delivery without retiring the session",
    async (method) => {
      const { client, conn } = makeHarness();
      await openSession(conn);
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
    const { client, conn } = makeHarness();
    const data: string[] = [];
    let exit: unknown;
    const opening = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.open", opening);
    const openPromise = openSession(conn, {
      onData: (chunk) => data.push(chunk),
      onExit: (info) => (exit = info),
    });
    // A shell that fails to exec exits before the client has a sink.
    emitData(client, 4, "boom");
    emitExit(client, { exitCode: 127, signal: null, reason: "process_exit" });
    expect(exit).toBeUndefined();

    opening.resolve(sessionResult({ shell: "/bad/shell" }));
    await openPromise;
    expect(data).toEqual(["boom"]);
    expect(exit).toEqual({ exitCode: 127, signal: null, reason: "process_exit", error: undefined });
    // Replaying the early exit releases the session — no leaked sink/listener.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("keeps the listener while an open is in flight even if every session closes", async () => {
    const { client, conn } = makeHarness();
    await openSession(conn);

    // Second open held in flight while the only registered session closes.
    const opening = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.open", opening);
    const data: string[] = [];
    const openPromise = openSession(conn, { onData: (chunk) => data.push(chunk) });

    await conn.close("s1");
    // The in-flight open must keep the subscription so s2's early output
    // is buffered instead of silently lost.
    expect(client.listenerCount()).toBe(1);
    emitData(client, 5, "early", "s2");

    opening.resolve(sessionResult({ sessionId: "s2" }));
    await openPromise;
    expect(data).toEqual(["early"]);
  });

  it("drops the final exit the server emits while a close RPC is in flight", async () => {
    const { client, conn } = makeHarness();
    await openSession(conn);
    // A second session keeps the event subscription alive across the close.
    client.nextResponse = sessionResult({ sessionId: "s2" });
    await openSession(conn);

    // The server finalizes the session (emitting terminal.exit) before it
    // responds to terminal.close, so the event arrives with no sink.
    const baseRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === "terminal.close") {
        emitExit(client, { exitCode: null, signal: null, reason: "closed" });
      }
      return baseRequest(method, params);
    }) as typeof client.request;
    await conn.close("s1");

    // If that exit were buffered, reusing the id would replay it into the new
    // session's sink and instantly mark a live tab as exited.
    client.nextResponse = sessionResult();
    let staleExit = false;
    await openSession(conn, {
      onExit: () => {
        staleExit = true;
      },
    });
    expect(staleExit).toBe(false);
    expect(conn.size).toBe(2);
  });

  it("attach replays the buffer before events that raced ahead, then resumes live", async () => {
    const { client, conn } = makeHarness();
    const data: string[] = [];
    const attached = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.attach", attached);

    const attachPromise = conn.attach("s1", testSink({ onData: (chunk) => data.push(chunk) }));
    // Post-snapshot bytes the server emits between rebind and the response.
    emitData(client, 21, " tail");
    expect(data).toEqual([]);

    attached.resolve(sessionResult({ buffer: "replayed history", seq: 16 }));
    const result = await attachPromise;
    expect(result.buffer).toBe("replayed history");
    expect(client.requests[0]).toEqual({
      method: "terminal.attach",
      params: { sessionId: "s1" },
    });
    // Buffer first, then the raced event, then live data.
    emitData(client, 26, " live");
    expect(data).toEqual(["replayed history", " tail", " live"]);
  });

  it("awaits asynchronous initial replay before flushing live output", async () => {
    const { client, conn } = makeHarness();
    const replay = createDeferred();
    const order: string[] = [];
    client.nextResponse = sessionResult({ buffer: "snapshot", seq: 8 });

    const attachPromise = conn.attach("s1", {
      onData: (chunk) => order.push(`data:${chunk}`),
      onReplay: async ({ data: snapshot, mode }) => {
        order.push(`${mode}:${snapshot}`);
        await replay.promise;
        order.push("replay:done");
      },
      onExit: () => {},
    });
    await vi.waitFor(() => expect(order).toEqual(["initial:snapshot"]));

    emitData(client, 9, "!");
    expect(order).toEqual(["initial:snapshot"]);
    replay.resolve();

    await attachPromise;
    expect(order).toEqual(["initial:snapshot", "replay:done", "data:!"]);
  });

  it("rejects initial replay failures without retaining a stream", async () => {
    const { client, conn } = makeHarness();
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
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("discards a detached exit that predates successful session adoption", async () => {
    const { client, conn } = makeHarness();
    const replays: string[] = [];
    const data: string[] = [];
    const exits: unknown[] = [];
    const attached = createDeferred<TestSessionResult>();
    deferRequest(client, "terminal.attach", attached);

    const attachPromise = conn.attach("s1", {
      onData: (chunk) => data.push(chunk),
      onReplay: ({ data: snapshot }) => {
        replays.push(snapshot);
      },
      onExit: (info) => exits.push(info),
    });
    emitExit(client, { exitCode: null, signal: null, reason: "detached" });
    attached.resolve(sessionResult({ buffer: "snapshot", seq: 8 }));

    await attachPromise;
    emitData(client, 9, "!");
    expect(replays).toEqual(["snapshot"]);
    expect(data).toEqual(["!"]);
    expect(exits).toEqual([]);
    expect(conn.size).toBe(1);
  });

  it.each(["buffer", "seq"] as const)(
    "rejects an unusable replay missing %s without retaining its event listener",
    async (field) => {
      const { client, conn } = makeHarness();
      const { [field]: _dropped, ...incomplete } = sessionResult({ buffer: "snapshot", seq: 8 });
      client.nextResponse = incomplete;

      await expect(conn.attach("s1", testSink())).rejects.toBeInstanceOf(
        TerminalOpenUnusableSessionError,
      );
      expect(conn.size).toBe(0);
      expect(client.listenerCount()).toBe(0);
    },
  );

  it("lists attachable sessions and tolerates a missing sessions field", async () => {
    const { client, conn } = makeHarness();
    const info = {
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
      attached: false,
      createdAtMs: 1,
    };
    client.nextResponse = { sessions: [info] };
    expect(await conn.list()).toEqual([info]);
    client.nextResponse = {};
    expect(await conn.list()).toEqual([]);
  });

  it("retains an active stream and pending input while Gateway application responses are delayed", () =>
    withFakeTimers(async () => {
      const { client, conn } = makeHarness();
      const onData = vi.fn();
      const onExit = vi.fn();
      await openSession(conn, { onData, onExit });

      const response = createDeferred<{ ok: boolean }>();
      deferRequest(client, "terminal.input", response);
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
            setTimeout(
              () => reject(new Error("Gateway application response timed out")),
              timeoutMs,
            );
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
        emitData(client, 6, "ready\n");
        expect(onData).toHaveBeenCalledExactlyOnceWith("ready\n");
      } finally {
        response.resolve({ ok: true });
        await input;
        conn.dispose();
      }
    }));

  // A reply after panel teardown must not retain a sink or event subscription.
  it.each([
    ["attach", "terminal.attach"],
    ["open", "terminal.open"],
  ] as const)(
    "a late %s reply after dispose() leaves no resurrected stream or listener",
    async (kind, method) => {
      const { client, conn } = makeHarness();
      const response = createDeferred<TestSessionResult & { buffer: string }>();
      deferRequest(client, method, response);
      const settle =
        kind === "attach"
          ? conn.attach("s1", testSink())
          : conn.open({ cols: 80, rows: 24 }, testSink());
      // Panel teardown (reconnect or element removal) discards the connection
      // while the RPC is still in flight.
      conn.dispose();
      response.resolve({ ...sessionResult(), buffer: "replayed\n", seq: 9 });
      await expect(settle).resolves.toMatchObject({ sessionId: "s1" });
      expect(conn.size).toBe(0);
      expect(client.listenerCount()).toBe(0);
    },
  );
});
