import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";

const callGatewayMock = vi.fn(async () => ({ ok: true }));
const isImplicitLocalGatewayTargetMock = vi.fn(async () => true);
vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
  isImplicitLocalGatewayTarget: isImplicitLocalGatewayTargetMock,
}));
vi.mock("./progress.js", () => ({
  withProgress: async (_options: unknown, action: () => Promise<unknown>) => await action(),
}));
const { callGatewayFromCliRuntime: call, isImplicitLocalGatewayTargetFromCliRuntime: classify } =
  await import("./gateway-rpc.runtime.js");

beforeEach(() => {
  callGatewayMock.mockClear().mockResolvedValue({ ok: true });
  vi.stubEnv("OPENCLAW_SHELL", undefined);
  vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("Gateway CLI transport", () => {
  it.each([
    {
      target: ["--url", "wss://gateway.example/ws"],
      expected: { url: "wss://gateway.example/ws" },
    },
    { target: ["--port", "19083"], expected: { localPortOverride: 19083 } },
  ])(
    "parses and forwards explicit authentication and target $target",
    async ({ target, expected }) => {
      const program = new Command().exitOverride();
      const action = vi.fn(async (opts: GatewayRpcOpts) => {
        await call("cron.status", opts);
      });
      addGatewayClientOptions(program.command("gateway-command")).action(action);
      await program.parseAsync(
        [
          "gateway-command",
          ...target,
          "--token",
          "test-gateway-token",
          "--password",
          "test-gateway-password",
        ],
        { from: "user" },
      );
      expect(action).toHaveBeenCalledOnce();
      expect(action.mock.calls[0]?.[0]).toMatchObject({
        [target[0]!.slice(2)]: target[1],
        token: "test-gateway-token",
        password: "test-gateway-password",
      });
      expect(callGatewayMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ...expected,
          token: "test-gateway-token",
          password: "test-gateway-password",
        }),
      );
    },
  );

  it.each([
    { timeout: undefined, defaultTimeoutMs: undefined, expected: 30_000 },
    { timeout: undefined, defaultTimeoutMs: 10_000, expected: 10_000 },
    { timeout: "15000", defaultTimeoutMs: 600_000, expected: 15_000 },
  ])(
    "resolves timeout $timeout with default $defaultTimeoutMs",
    async ({ timeout, defaultTimeoutMs, expected }) => {
      await call("cron.status", { timeout }, undefined, { defaultTimeoutMs });
      expect(callGatewayMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: "cron.status", timeoutMs: expected }),
      );
    },
  );

  it("forwards specialized connection, authorization and cancellation context", async () => {
    const config = { gateway: { mode: "local" as const } };
    const controller = new AbortController();
    const target = { config, localPortOverride: 19083, expectUrl: "ws://127.0.0.1:19083" };
    const extra = {
      timeoutMs: null,
      scopes: ["operator.read", "operator.pairing"],
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.read", "operator.pairing"],
      requireLocalBackendSharedAuth: true,
      signal: controller.signal,
    } satisfies NonNullable<Parameters<typeof call>[3]>;
    await call("node.list", target, {}, extra);
    expect(callGatewayMock).toHaveBeenCalledWith(expect.objectContaining({ ...target, ...extra }));
  });

  it("preserves pinned, read-only existing-device auth through the public SDK facade", async () => {
    const params = { key: "agent:test:incoming-call:synthetic", idempotencyKey: "synthetic" };
    await callGatewayFromCli(
      "sessions.create",
      { expectUrl: "wss://gateway.example:18789", json: true },
      params,
      {
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.write"],
        sharedStateMode: "read-only",
        progress: false,
      },
    );

    expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: "sessions.create",
        params,
        expectUrl: "wss://gateway.example:18789",
        // A pin must not become an override; canonical transport selects and checks the target.
        url: undefined,
        token: undefined,
        password: undefined,
        deviceIdentity: undefined,
        scopes: undefined,
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.write"],
        sharedStateMode: "read-only",
      }),
    );
  });

  it.each([
    { opts: { port: " \t " }, error: "--port must be an integer between 1 and 65535." },
    {
      opts: { url: "ws://127.0.0.1:19083", port: "19083" },
      error: "Use either --url or --port, not both.",
    },
    {
      opts: { timeout: "10ms" },
      error:
        'Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "10ms".',
    },
    { opts: { timeout: "   " }, error: "Invalid --timeout" },
  ])("rejects invalid options $opts before connecting", async ({ opts, error }) => {
    await expect(call("cron.status", opts)).rejects.toThrow(error);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("classifies the CLI target through the canonical Gateway classifier", async () => {
    isImplicitLocalGatewayTargetMock.mockResolvedValueOnce(false);
    await expect(classify({ url: "ws://127.0.0.1:18789", token: "token" })).resolves.toBe(false);
    expect(isImplicitLocalGatewayTargetMock).toHaveBeenCalledWith({
      config: undefined,
      url: "ws://127.0.0.1:18789",
      localPortOverride: undefined,
    });
  });
});

describe("agent exec session input", () => {
  it.each(["sessions.send", "sessions.steer", "chat.send"])(
    "refuses subagent shell %s",
    async (method) => {
      vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", "1");
      await expect(call(method, {}, { key: "agent:main:main", message: "Done" })).rejects.toThrow(
        "task completion path",
      );
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { shell: undefined, subagent: undefined, method: "sessions.send" },
    { shell: undefined, subagent: "1", method: "sessions.history" },
    { shell: "exec", subagent: undefined, method: "health" },
  ])(
    "preserves permitted $method with shell=$shell subagent=$subagent",
    async ({ shell, subagent, method }) => {
      vi.stubEnv("OPENCLAW_SHELL", shell);
      vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", subagent);
      await call(method, {}, { key: "agent:main:main", message: "Human request" });
      expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          method,
          params: { key: "agent:main:main", message: "Human request" },
        }),
      );
    },
  );

  it.each(["sessions.send", "sessions.steer", "chat.send", "agent"])(
    "refuses %s despite claimed provenance and connection overrides",
    async (method) => {
      vi.stubEnv("OPENCLAW_SHELL", "exec");
      await expect(
        call(
          method,
          { json: true, url: "wss://gateway.example/ws", token: "fixture-token" },
          {
            message: "[Inter-session message] Worker result",
            sourceSessionKey: "agent:main:worker",
          },
          { clientName: "gateway-client", mode: "backend", scopes: ["operator.admin"] },
        ),
      ).rejects.toThrow(/inter-session attribution/);
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { message: "Worker result" },
    { task: "Worker task" },
    { attachments: [{ type: "image", content: "fixture" }] },
  ])("refuses initial session input through sessions.create: %j", async (params) => {
    vi.stubEnv("OPENCLAW_SHELL", "exec");
    await expect(call("sessions.create", {}, params)).rejects.toThrow(/inter-session attribution/);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("preserves session creation without an initial turn", async () => {
    vi.stubEnv("OPENCLAW_SHELL", "exec");
    await call("sessions.create", {}, { key: "agent:main:empty", message: " ", attachments: [] });
    expect(callGatewayMock).toHaveBeenCalledOnce();
  });
});
