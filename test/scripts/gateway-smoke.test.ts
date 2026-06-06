// Gateway Smoke tests cover gateway smoke script behavior.
import { describe, expect, it } from "vitest";
import { runGatewaySmoke } from "../../scripts/dev/gateway-smoke.js";

describe("gateway-smoke", () => {
  function createSmokeDeps(
    responses: Record<string, { error?: string; ok: boolean }>,
    calls: Array<{ method: string; timeout?: number }> = [],
  ) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let closed = 0;

    return {
      calls,
      get closed() {
        return closed;
      },
      stderr,
      stdout,
      deps: {
        createClient: () =>
          ({
            close: () => {
              closed += 1;
            },
            request: async (method: string, _params?: unknown, timeout?: number) => {
              calls.push({ method, timeout });
              return {
                id: method,
                ok: responses[method]?.ok ?? false,
                error: responses[method]?.error,
                type: "res",
              };
            },
            waitOpen: async () => {},
          }) as never,
        stderr: (message: string) => {
          stderr.push(message);
        },
        stdout: (message: string) => {
          stdout.push(message);
        },
      },
    };
  }

  it("closes the websocket client when connect fails", async () => {
    const stderr: string[] = [];
    const methods: string[] = [];
    let closed = 0;

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      {
        createClient: () =>
          ({
            close: () => {
              closed += 1;
            },
            request: async (method: string) => {
              methods.push(method);
              return { error: "bad token", id: "connect", ok: false, type: "res" };
            },
            waitOpen: async () => {},
          }) as never,
        stderr: (message) => {
          stderr.push(message);
        },
        stdout: () => {},
      },
    );

    expect(code).toBe(2);
    expect(closed).toBe(1);
    expect(methods).toEqual(["connect"]);
    expect(stderr).toEqual(["connect failed: bad token"]);
  });

  it("requires connect, health, and chat history in order", async () => {
    const fake = createSmokeDeps({
      connect: { ok: true },
      health: { ok: true },
      "chat.history": { ok: true },
    });

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      fake.deps,
    );

    expect(code).toBe(0);
    expect(fake.closed).toBe(1);
    expect(fake.calls).toEqual([
      { method: "connect", timeout: undefined },
      { method: "health", timeout: undefined },
      { method: "chat.history", timeout: 15000 },
    ]);
    expect(fake.stdout).toEqual(["ok: connected + health + chat.history"]);
    expect(fake.stderr).toEqual([]);
  });

  it("fails after connect when health is unavailable", async () => {
    const fake = createSmokeDeps({
      connect: { ok: true },
      health: { ok: false, error: "not healthy" },
    });

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      fake.deps,
    );

    expect(code).toBe(3);
    expect(fake.closed).toBe(1);
    expect(fake.calls.map((call) => call.method)).toEqual(["connect", "health"]);
    expect(fake.stderr).toEqual(["health failed: not healthy"]);
  });

  it("fails after health when chat history is unavailable", async () => {
    const fake = createSmokeDeps({
      connect: { ok: true },
      health: { ok: true },
      "chat.history": { ok: false, error: "session store unavailable" },
    });

    const code = await runGatewaySmoke(
      { token: "secret-token", urlRaw: "ws://127.0.0.1:12345" },
      fake.deps,
    );

    expect(code).toBe(4);
    expect(fake.closed).toBe(1);
    expect(fake.calls).toEqual([
      { method: "connect", timeout: undefined },
      { method: "health", timeout: undefined },
      { method: "chat.history", timeout: 15000 },
    ]);
    expect(fake.stderr).toEqual(["chat.history failed: session store unavailable"]);
  });
});
