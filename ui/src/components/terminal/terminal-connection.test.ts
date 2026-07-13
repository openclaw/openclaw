import { describe, expect, it } from "vitest";
import { TerminalConnection, type TerminalGatewayClient } from "./terminal-connection.ts";

/** Fake gateway client that records requests and lets tests push events. */
function makeFakeClient() {
  const listeners = new Set<(evt: { event: string; payload: unknown }) => void>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client: TerminalGatewayClient & {
    requests: typeof requests;
    emit: (event: string, payload: unknown) => void;
    listenerCount: () => number;
    nextResponse: unknown;
  } = {
    requests,
    nextResponse: {
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
    },
    request: <T>(method: string, params?: unknown) => {
      requests.push({ method, params });
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
    listenerCount: () => listeners.size,
  };
  return client;
}

describe("TerminalConnection", () => {
  it("opens a session and routes its data to the registered sink", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    const result = await conn.open(
      { cols: 80, rows: 24 },
      { onData: (d) => data.push(d), onExit: () => {} },
    );

    expect(result.sessionId).toBe("s1");
    expect(client.requests[0]).toEqual({ method: "terminal.open", params: { cols: 80, rows: 24 } });

    client.emit("terminal.data", { sessionId: "s1", seq: 0, data: "hello" });
    client.emit("terminal.data", { sessionId: "s1", seq: 1, data: "!" });
    expect(data).toEqual(["hello", "!"]);
  });

  it("forwards the selected agent when opening a session", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open(
      { agentId: "ops", cols: 100, rows: 30 },
      { onData: () => {}, onExit: () => {} },
    );

    expect(client.requests[0]).toEqual({
      method: "terminal.open",
      params: { agentId: "ops", cols: 100, rows: 30 },
    });
  });

  it("does not deliver data to the wrong session", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    await conn.open({ cols: 80, rows: 24 }, { onData: (d) => data.push(d), onExit: () => {} });
    client.emit("terminal.data", { sessionId: "other", seq: 0, data: "nope" });
    expect(data).toEqual([]);
  });

  it("delivers exit info to the owning session", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    let exit: unknown;
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: (info) => (exit = info) });
    client.emit("terminal.exit", {
      sessionId: "s1",
      exitCode: 0,
      signal: null,
      reason: "process_exit",
    });
    expect(exit).toEqual({ exitCode: 0, signal: null, reason: "process_exit", error: undefined });
    // The connection drops its own sink on exit so nothing leaks.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("sends input, resize, and close RPCs", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    await conn.input("s1", "ls\n");
    await conn.resize("s1", 120, 40);
    await conn.close("s1");
    expect(client.requests.map((r) => r.method)).toEqual([
      "terminal.open",
      "terminal.input",
      "terminal.resize",
      "terminal.close",
    ]);
  });

  it("buffers output that races ahead of sink registration and replays it in order", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    // Hold the open response so data can arrive before the sink registers.
    let resolveOpen: (() => void) | undefined;
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      if (method === "terminal.open") {
        return new Promise<unknown>((resolve) => {
          resolveOpen = () =>
            resolve({
              sessionId: "s1",
              agentId: "main",
              shell: "/bin/zsh",
              cwd: "/work",
              confined: false,
            });
        });
      }
      return Promise.resolve({});
    }) as typeof client.request;

    const openPromise = conn.open(
      { cols: 80, rows: 24 },
      { onData: (d) => data.push(d), onExit: () => {} },
    );
    // Server streams the shell prompt before the client has a sink for s1.
    client.emit("terminal.data", { sessionId: "s1", seq: 0, data: "prompt" });
    client.emit("terminal.data", { sessionId: "s1", seq: 1, data: "$ " });
    expect(data).toEqual([]); // buffered, not dropped

    resolveOpen?.();
    await openPromise;
    expect(data).toEqual(["prompt", "$ "]); // replayed in arrival order on registration
  });

  it("buffers an instant exit that races ahead of registration", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    let exit: unknown;
    let resolveOpen: (() => void) | undefined;
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      if (method === "terminal.open") {
        return new Promise<unknown>((resolve) => {
          resolveOpen = () =>
            resolve({
              sessionId: "s1",
              agentId: "main",
              shell: "/bad/shell",
              cwd: "/work",
              confined: false,
            });
        });
      }
      return Promise.resolve({});
    }) as typeof client.request;

    const openPromise = conn.open(
      { cols: 80, rows: 24 },
      { onData: (d) => data.push(d), onExit: (info) => (exit = info) },
    );
    // A shell that fails to exec exits before the client has a sink.
    client.emit("terminal.data", { sessionId: "s1", seq: 0, data: "boom" });
    client.emit("terminal.exit", {
      sessionId: "s1",
      exitCode: 127,
      signal: null,
      reason: "process_exit",
    });
    expect(exit).toBeUndefined();

    resolveOpen?.();
    await openPromise;
    expect(data).toEqual(["boom"]);
    expect(exit).toEqual({ exitCode: 127, signal: null, reason: "process_exit", error: undefined });
    // Replaying the early exit releases the session — no leaked sink/listener.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("unsubscribes from the event stream once no sessions remain", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    expect(client.listenerCount()).toBe(1);
    await conn.close("s1");
    expect(client.listenerCount()).toBe(0);
    expect(conn.size).toBe(0);
  });

  it("drops the listener when an open fails so failures do not leak subscriptions", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      // Rejected open: sandboxed agent, disabled terminal, missing PTY, etc.
      return Promise.reject(new Error("terminal open refused"));
    }) as typeof client.request;

    await expect(
      conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} }),
    ).rejects.toThrow("terminal open refused");
    // The failed open subscribed but never registered a sink; repeated failures
    // across reconnects must not accumulate listeners on the gateway client.
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("keeps the listener while an open is in flight even if every session closes", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });

    // Second open held in flight while the only registered session closes.
    let resolveOpen: (() => void) | undefined;
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      if (method === "terminal.open") {
        return new Promise<unknown>((resolve) => {
          resolveOpen = () =>
            resolve({
              sessionId: "s2",
              agentId: "main",
              shell: "/bin/zsh",
              cwd: "/work",
              confined: false,
            });
        });
      }
      return Promise.resolve({});
    }) as typeof client.request;
    const data: string[] = [];
    const openPromise = conn.open(
      { cols: 80, rows: 24 },
      { onData: (d) => data.push(d), onExit: () => {} },
    );

    await conn.close("s1");
    // The in-flight open must keep the subscription so s2's early output
    // is buffered instead of silently lost.
    expect(client.listenerCount()).toBe(1);
    client.emit("terminal.data", { sessionId: "s2", seq: 0, data: "early" });

    resolveOpen?.();
    await openPromise;
    expect(data).toEqual(["early"]);
  });

  it("drops the final exit the server emits while a close RPC is in flight", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    // A second session keeps the event subscription alive across the close.
    client.nextResponse = {
      sessionId: "s2",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
    };
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });

    // The server finalizes the session (emitting terminal.exit) before it
    // responds to terminal.close, so the event arrives with no sink.
    const baseRequest = client.request.bind(client);
    client.request = ((method: string, params: unknown) => {
      if (method === "terminal.close") {
        client.emit("terminal.exit", {
          sessionId: "s1",
          exitCode: null,
          signal: null,
          reason: "closed",
        });
      }
      return baseRequest(method, params);
    }) as typeof client.request;
    await conn.close("s1");

    // If that exit were buffered, reusing the id would replay it into the new
    // session's sink and instantly mark a live tab as exited.
    client.nextResponse = {
      sessionId: "s1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/work",
      confined: false,
    };
    let staleExit = false;
    await conn.open(
      { cols: 80, rows: 24 },
      {
        onData: () => {},
        onExit: () => {
          staleExit = true;
        },
      },
    );
    expect(staleExit).toBe(false);
    expect(conn.size).toBe(2);
  });

  it("attach replays the buffer before events that raced ahead, then resumes live", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    const data: string[] = [];
    let resolveAttach: (() => void) | undefined;
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      if (method === "terminal.attach") {
        return new Promise<unknown>((resolve) => {
          resolveAttach = () =>
            resolve({
              sessionId: "s1",
              agentId: "main",
              shell: "/bin/zsh",
              cwd: "/work",
              confined: false,
              buffer: "replayed history",
            });
        });
      }
      return Promise.resolve({});
    }) as typeof client.request;

    const attachPromise = conn.attach("s1", {
      onData: (d) => data.push(d),
      onExit: () => {},
    });
    // Post-snapshot bytes the server emits between rebind and the response.
    client.emit("terminal.data", { sessionId: "s1", seq: 5, data: " tail" });
    expect(data).toEqual([]);

    resolveAttach?.();
    const result = await attachPromise;
    expect(result.buffer).toBe("replayed history");
    expect(client.requests[0]).toEqual({
      method: "terminal.attach",
      params: { sessionId: "s1" },
    });
    // Buffer first, then the raced event, then live data.
    client.emit("terminal.data", { sessionId: "s1", seq: 6, data: " live" });
    expect(data).toEqual(["replayed history", " tail", " live"]);
  });

  it("drops the listener when an attach fails so failures do not leak subscriptions", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    client.request = ((method: string, params: unknown) => {
      client.requests.push({ method, params });
      // Expired/unknown session after the detach grace period.
      return Promise.reject(new Error("unknown terminal session"));
    }) as typeof client.request;

    await expect(conn.attach("gone", { onData: () => {}, onExit: () => {} })).rejects.toThrow(
      "unknown terminal session",
    );
    expect(conn.size).toBe(0);
    expect(client.listenerCount()).toBe(0);
  });

  it("lists attachable sessions and tolerates a missing sessions field", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
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

  it("dispose() drops the gateway subscription and clears buffered state", async () => {
    const client = makeFakeClient();
    const conn = new TerminalConnection(client);
    await conn.open({ cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
    expect(client.listenerCount()).toBe(1);
    // Panel teardown (disconnect/disable) discards the connection.
    conn.dispose();
    expect(client.listenerCount()).toBe(0);
    expect(conn.size).toBe(0);
  });
});
