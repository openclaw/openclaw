// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import {
  TerminalConnection,
  type TerminalGatewayClient,
  TerminalOpenTimeoutError,
  TerminalOpenUnusableSessionError,
} from "./terminal-connection.ts";

type TerminalSink = Parameters<TerminalConnection["open"]>[1];
type RequestOptions = Parameters<TerminalGatewayClient["request"]>[2];
type TestSessionResult = Awaited<ReturnType<TerminalConnection["open"]>> & {
  buffer?: string;
  seq?: number;
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

class FakeClient implements TerminalGatewayClient {
  listeners = new Set<Parameters<TerminalGatewayClient["addEventListener"]>[0]>();
  requests: Array<{ method: string; params: unknown; options?: RequestOptions }> = [];
  replies = new Map<string, (options?: RequestOptions) => unknown>();
  forceReconnects: string[] = [];
  nextResponse: unknown = sessionResult();

  request<T>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
    this.requests.push({ method, params, ...(options ? { options } : {}) });
    const reply = this.replies.get(method);
    return Promise.resolve((reply ? reply(options) : this.nextResponse) as T);
  }
  addEventListener(listener: Parameters<TerminalGatewayClient["addEventListener"]>[0]) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: string, payload: unknown) {
    for (const listener of this.listeners) {
      listener({ event, payload });
    }
  }
  forceReconnect(reason: string) {
    this.forceReconnects.push(reason);
  }
}

let client: FakeClient;
let conn: TerminalConnection;
let data: string[];
let replays: string[];
let exits: unknown[];
beforeEach(() => {
  client = new FakeClient();
  conn = new TerminalConnection(client);
  data = [];
  replays = [];
  exits = [];
});
afterEach(() => {
  conn.dispose();
  vi.useRealTimers();
});
function expectRetired() {
  expect(conn.size).toBe(0);
  expect(client.listeners.size).toBe(0);
}
function testSink(overrides: Partial<TerminalSink> = {}): TerminalSink {
  return {
    onData: (chunk) => data.push(chunk),
    onReplay: ({ data: snapshot }) => {
      replays.push(snapshot);
    },
    onExit: (info) => exits.push(info),
    ...overrides,
  };
}

function openSession(overrides: Partial<TerminalSink> = {}) {
  return conn.open({ cols: 80, rows: 24 }, testSink(overrides));
}

function emitData(seq: number, chunk: string, sessionId = "s1"): void {
  client.emit("terminal.data", { sessionId, seq, data: chunk });
}

function emitExit(info: Parameters<TerminalSink["onExit"]>[0]): void {
  client.emit("terminal.exit", { sessionId: "s1", ...info });
}

function heldReplay() {
  const pending = createDeferred();
  return { ...pending, apply: vi.fn<TerminalSink["onReplay"]>(() => pending.promise) };
}

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

it("does not let a superseded recovery drain the replacement stream queue", async () => {
  const oldReplay = heldReplay();
  await openSession({ onData: () => {}, onReplay: oldReplay.apply });
  client.nextResponse = sessionResult({ buffer: "old snapshot", seq: 12 });
  emitData(5, "hello");
  emitData(12, "world");
  await vi.waitFor(() => expect(oldReplay.apply).toHaveBeenCalledOnce());
  const signal = oldReplay.apply.mock.calls[0]![0].signal;
  expect(signal.aborted).toBe(false);

  const newReplay = heldReplay();
  client.nextResponse = sessionResult({ buffer: "new snapshot", seq: 20 });
  const newAttach = conn.attach("s1", testSink({ onReplay: newReplay.apply }));
  await vi.waitFor(() => expect(newReplay.apply).toHaveBeenCalledOnce());
  expect(signal.aborted).toBe(true);
  emitData(21, "!");
  oldReplay.resolve();
  await vi.waitFor(() => expect(oldReplay.apply.mock.settledResults[0]?.type).toBe("fulfilled"));
  await Promise.resolve();
  newReplay.resolve();
  await newAttach;
  expect(data).toEqual(["!"]);
});

it("retries an unapplied resume suffix after its replay fails", async () => {
  let replayFailed = false;
  await openSession({
    onReplay: ({ data: snapshot, newlyObservedFrom }) => {
      if (!replayFailed) {
        replayFailed = true;
        throw new Error("emulator unavailable");
      }
      data.push(snapshot.slice(newlyObservedFrom));
    },
  });
  emitData(5, "hello");
  conn.suspend();
  client.nextResponse = sessionResult({ buffer: "helloagain", seq: 10 });
  expect((await conn.resume()).has("s1")).toBe(true);
  expect(data.join("")).toBe("hello");

  conn.suspend();
  expect((await conn.resume()).size).toBe(0);
  emitData(11, "!");
  expect(data.join("")).toBe("helloagain!");
});

it("delivers the received tail and exit when recovery loses the finished session", async () => {
  await openSession();
  const recovery = createDeferred<never>();
  client.replies.set("terminal.attach", () => recovery.promise);

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

it.each([false, true])(
  "orders early output and exit through registration (gap=%s)",
  async (gap) => {
    const opening = createDeferred<TestSessionResult>();
    const recovery = createDeferred<TestSessionResult>();
    client.replies.set("terminal.open", () => opening.promise);
    client.replies.set("terminal.attach", () => recovery.promise);
    const opened = openSession();
    emitData(gap ? 7 : 4, gap ? "first" : "boom");
    const exit = {
      exitCode: gap ? 0 : 127,
      signal: null,
      reason: gap ? undefined : "process_exit",
    };
    emitExit(exit);
    expect(exits).toEqual([]);
    opening.resolve(sessionResult({ shell: "/bad/shell" }));
    await opened;
    if (gap) {
      expect(exits).toEqual([]);
      recovery.resolve(sessionResult({ buffer: "complete output", seq: 7 }));
      await vi.waitFor(() => expect(exits).toHaveLength(1));
    }
    expect(data).toEqual(gap ? [] : ["boom"]);
    expect(replays).toEqual(gap ? ["complete output"] : []);
    expect(exits).toEqual([{ ...exit, error: undefined }]);
    expectRetired();
  },
);

it("reconnects when the browser watchdog cannot receive the Gateway deadline", async () => {
  client.replies.set("terminal.open", (options) => {
    return Promise.reject(
      new Error(`gateway request timed out after ${options?.timeoutMs}ms: terminal.open`),
    );
  });
  await expect(openSession()).rejects.toBeInstanceOf(TerminalOpenTimeoutError);
  expect(client.forceReconnects).toEqual(["terminal open watchdog timeout"]);
});

it("marks the session unavailable when resize rejects its live owner", async () => {
  await openSession();
  client.nextResponse = { ok: false };

  await conn.resize("s1", 120, 40);

  expect(exits).toHaveLength(1);
  expect(exits[0]).toMatchObject({ reason: "disconnected", error: expect.any(String) });
  expectRetired();
});

it("reports rejected and unconfirmed input without retiring the session", async () => {
  await openSession();
  const act = () => conn.input("s1", "typed");
  client.nextResponse = null;
  await expect(act()).rejects.toThrow("delivery could not be confirmed");
  const request = vi.spyOn(client, "request").mockRejectedValueOnce(new Error("offline"));
  await expect(act()).rejects.toThrow("offline");
  expect(conn.size).toBe(1);
  request.mockRestore();
});

it("keeps the listener while an open is in flight even if every session closes", async () => {
  await openSession();

  const opening = createDeferred<TestSessionResult>();
  client.replies.set("terminal.open", () => opening.promise);
  const openPromise = openSession({ onData: (chunk) => data.push(chunk) });

  await conn.close("s1");
  expect(client.listeners.size).toBe(1);
  emitData(5, "early", "s2");

  opening.resolve(sessionResult({ sessionId: "s2" }));
  await openPromise;
  expect(data).toEqual(["early"]);
});

it("drops the final exit the server emits while a close RPC is in flight", async () => {
  await openSession();
  client.nextResponse = sessionResult({ sessionId: "s2" });
  await openSession();

  client.replies.set("terminal.close", () => {
    emitExit({ exitCode: null, signal: null, reason: "closed" });
    return client.nextResponse;
  });
  await conn.close("s1");

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

it.each(["initial", "recovery"] as const)(
  "orders %s replay, racing frames and live output",
  async (mode) => {
    const attached = createDeferred<TestSessionResult>();
    const replay = createDeferred();
    const order: string[] = [];
    const snapshot = "hello??worldcovered";
    let observedFrom = -1;
    const onReplay: TerminalSink["onReplay"] = async (frame) => {
      observedFrom = frame.newlyObservedFrom;
      order.push(frame.mode + ":" + frame.data);
      await replay.promise;
      order.push("replay:done");
    };
    const receiver = testSink({ onData: (chunk) => order.push("data:" + chunk), onReplay });
    if (mode === "recovery") {
      await openSession(receiver);
      emitData(5, "hello");
    }
    client.replies.set("terminal.attach", () => attached.promise);
    const attaching = mode === "initial" ? conn.attach("s1", receiver) : undefined;
    emitData(0, "nope", "other");
    emitData(12, "world");
    emitData(19, "covered");
    emitExit({ exitCode: null, signal: null, reason: "detached" });
    emitData(24, " tail");
    const prefix = mode === "recovery" ? ["data:hello"] : [];
    expect(order).toEqual(prefix);
    attached.resolve(sessionResult({ buffer: snapshot, seq: 19 }));
    await vi.waitFor(() => expect(order).toEqual([...prefix, mode + ":" + snapshot]));
    expect(observedFrom).toBe(mode === "initial" ? 19 : 5);
    emitData(29, " live");
    expect(order).toEqual([...prefix, mode + ":" + snapshot]);
    replay.resolve();
    await attaching;
    await vi.waitFor(() => expect(order).toContain("data: tail"));
    emitData(30, "!");
    expect(order).toEqual([
      ...prefix,
      mode + ":" + snapshot,
      "replay:done",
      "data: tail",
      "data: live",
      "data:!",
    ]);
    expect(client.requests.filter(({ method }) => method === "terminal.attach")).toHaveLength(1);
  },
);
it("rejects initial replay failures without retaining a stream", async () => {
  client.nextResponse = sessionResult({ buffer: "snapshot", seq: 8 });

  let replaySignal: AbortSignal | undefined;
  await expect(
    conn.attach(
      "s1",
      testSink({
        onReplay: async ({ signal }) => {
          replaySignal = signal;
          throw new Error("replay failed");
        },
      }),
    ),
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

it("retains an active stream and pending input while Gateway application responses are delayed", async () => {
  vi.useFakeTimers();
  await openSession();

  const response = createDeferred<{ ok: boolean }>();
  client.replies.set("terminal.input", (options) => {
    const timeoutMs = options?.timeoutMs;
    if (timeoutMs != null) {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Gateway application response timed out")), timeoutMs);
      });
    }
    return response.promise;
  });

  const settled = vi.fn();
  const input = conn.input("s1", "echo ready\n").then(settled);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(client.forceReconnects).toEqual([]);
  expect(exits).toEqual([]);
  expect(conn.size).toBe(1);
  expect(client.listeners.size).toBe(1);
  expect(settled).not.toHaveBeenCalled();

  response.resolve({ ok: true });
  await input;
  emitData(6, "ready\n");
  expect(data).toEqual(["ready\n"]);
});

it.each(["attach", "open"] as const)(
  "a late %s reply after dispose() leaves no resurrected stream or listener",
  async (kind) => {
    const response = createDeferred<TestSessionResult & { buffer: string }>();
    client.replies.set(`terminal.${kind}`, () => response.promise);
    const settle =
      kind === "attach"
        ? conn.attach("s1", testSink())
        : conn.open({ cols: 80, rows: 24 }, testSink());
    conn.dispose();
    response.resolve({ ...sessionResult(), buffer: "replayed\n", seq: 9 });
    await expect(settle).resolves.toMatchObject({ sessionId: "s1" });
    expectRetired();
  },
);
