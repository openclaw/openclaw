import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const callGateway = vi.fn(async () => ({ ok: true }));
const randomIdempotencyKey = vi.fn(() => "rk_test");
const startGatewayServer = vi.fn(async () => ({
  close: vi.fn(async () => {}),
}));
const setVerbose = vi.fn();
const createDefaultDeps = vi.fn();
const forceFreePortAndWait = vi.fn(async () => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));

const runtimeLogs: string[] = [];
const runtimeErrors: string[] = [];
const defaultRuntime = {
  log: (msg: string) => runtimeLogs.push(msg),
  error: (msg: string) => runtimeErrors.push(msg),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts),
  randomIdempotencyKey: () => randomIdempotencyKey(),
}));

vi.mock("../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) =>
    startGatewayServer(port, opts),
}));

vi.mock("../globals.js", () => ({
  info: (msg: string) => msg,
  isVerbose: () => false,
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("./deps.js", () => ({
  createDefaultDeps: () => createDefaultDeps(),
}));

vi.mock("./ports.js", () => ({
  forceFreePortAndWait: (port: number) => forceFreePortAndWait(port),
}));

describe("gateway-cli coverage", () => {
  it("registers call/health/status/send/agent commands and routes to callGateway", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(
      ["gateway", "call", "health", "--params", '{"x":1}'],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"ok": true');
  });

  it("fails gateway call on invalid params JSON", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await expect(
      program.parseAsync(
        ["gateway", "call", "status", "--params", "not-json"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway call failed:");
  });

  it("fills idempotency keys for send/agent when missing", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();
    randomIdempotencyKey.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(
      ["gateway", "send", "--to", "+1555", "--message", "hi"],
      { from: "user" },
    );

    await program.parseAsync(
      ["gateway", "agent", "--message", "hello", "--deliver"],
      { from: "user" },
    );

    expect(randomIdempotencyKey).toHaveBeenCalled();
    const callArgs = callGateway.mock.calls.map((c) => c[0]) as Array<{
      method: string;
      params?: { idempotencyKey?: string };
      expectFinal?: boolean;
    }>;
    expect(callArgs.some((c) => c.method === "send")).toBe(true);
    expect(
      callArgs.some((c) => c.method === "agent" && c.expectFinal === true),
    ).toBe(true);
    expect(callArgs.every((c) => c.params?.idempotencyKey === "rk_test")).toBe(
      true,
    );
  });

  it("passes gifPlayback for gateway send when flag set", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGateway.mockClear();
    randomIdempotencyKey.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(
      ["gateway", "send", "--to", "+1555", "--message", "hi", "--gif-playback"],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "send",
        params: expect.objectContaining({ gifPlayback: true }),
      }),
    );
  });

  it("validates gateway ports and handles force/start errors", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;

    const { registerGatewayCli } = await import("./gateway-cli.js");

    // Invalid port
    const programInvalidPort = new Command();
    programInvalidPort.exitOverride();
    registerGatewayCli(programInvalidPort);
    await expect(
      programInvalidPort.parseAsync(["gateway", "--port", "0"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    // Force free failure
    forceFreePortAndWait.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const programForceFail = new Command();
    programForceFail.exitOverride();
    registerGatewayCli(programForceFail);
    await expect(
      programForceFail.parseAsync(
        ["gateway", "--port", "18789", "--force", "--allow-unconfigured"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    // Start failure (generic)
    startGatewayServer.mockRejectedValueOnce(new Error("nope"));
    const programStartFail = new Command();
    programStartFail.exitOverride();
    registerGatewayCli(programStartFail);
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const beforeSigint = new Set(process.listeners("SIGINT"));
    await expect(
      programStartFail.parseAsync(
        ["gateway", "--port", "18789", "--allow-unconfigured"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.has(listener))
        process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.has(listener))
        process.removeListener("SIGINT", listener);
    }
  });
});
