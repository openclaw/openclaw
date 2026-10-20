import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addGatewayClientOptions } from "./gateway-rpc.js";
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
const auth = { token: "test-gateway-token", password: "test-gateway-password" };
const credentials = ["--token", auth.token, "--password", auth.password];
const expectCall = (fields: Record<string, unknown>) =>
  expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(fields));

beforeEach(() => {
  callGatewayMock.mockClear().mockResolvedValue({ ok: true });
  vi.stubEnv("OPENCLAW_SHELL", undefined);
  vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("Gateway CLI transport", () => {
  it.each([
    ["url", "wss://gateway.example/ws", { url: "wss://gateway.example/ws" }],
    ["port", "19083", { localPortOverride: 19083 }],
  ] as const)(
    "parses and forwards explicit authentication and target --%s",
    async (option, value, expected) => {
      const program = new Command().exitOverride();
      addGatewayClientOptions(program.command("gateway-command")).action((opts: GatewayRpcOpts) =>
        call("cron.status", opts),
      );
      await program.parseAsync(["gateway-command", `--${option}`, value, ...credentials], {
        from: "user",
      });
      expectCall({ ...expected, ...auth });
    },
  );

  it.each([
    [undefined, undefined, 30_000],
    [undefined, 10_000, 10_000],
    ["15000", 600_000, 15_000],
  ] as const)(
    "resolves timeout %s with default %s",
    async (timeout, defaultTimeoutMs, expected) => {
      await call("cron.status", { timeout }, undefined, { defaultTimeoutMs });
      expectCall({ method: "cron.status", timeoutMs: expected });
    },
  );

  it("forwards specialized connection, authorization and cancellation context", async () => {
    const controller = new AbortController();
    const target = {
      config: { gateway: { mode: "local" as const } },
      localPortOverride: 19083,
      expectUrl: "ws://127.0.0.1:19083",
    };
    const extra = {
      timeoutMs: null,
      scopes: ["operator.read", "operator.pairing"],
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.read", "operator.pairing"],
      requireLocalBackendSharedAuth: true,
      signal: controller.signal,
    } satisfies NonNullable<Parameters<typeof call>[3]>;
    await call("node.list", target, {}, extra);
    expectCall({ ...target, ...extra });
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
  it.each([
    { shell: undefined, subagent: undefined, method: "sessions.send" },
    { shell: undefined, subagent: "1", method: "sessions.history" },
    { shell: "exec", subagent: undefined, method: "health" },
  ])(
    "preserves permitted $method with shell=$shell subagent=$subagent",
    async ({ shell, subagent, method }) => {
      vi.stubEnv("OPENCLAW_SHELL", shell);
      vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", subagent);
      const params = { key: "agent:main:main", message: "Human request" };
      await call(method, {}, params);
      expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ method, params }),
      );
    },
  );

  it("preserves session creation without an initial turn", async () => {
    vi.stubEnv("OPENCLAW_SHELL", "exec");
    await call("sessions.create", {}, { key: "agent:main:empty", message: " ", attachments: [] });
    expect(callGatewayMock).toHaveBeenCalledOnce();
  });
});

type Refusal = [
  args: Parameters<typeof call>,
  error: string | RegExp,
  source?: "exec" | "subagent",
];
const subagentRefusal = (method: string): Refusal => [
  [method, {}, { key: "agent:main:main", message: "Done" }],
  "task completion path",
  "subagent",
];
const execRefusal = (method: string): Refusal => [
  [
    method,
    { json: true, url: "wss://gateway.example/ws", token: "fixture-token" },
    { message: "[Inter-session message] Worker result", sourceSessionKey: "agent:main:worker" },
    { clientName: "gateway-client", mode: "backend", scopes: ["operator.admin"] },
  ],
  /inter-session attribution/,
  "exec",
];
it.each([
  [["cron.status", { port: " \t " }], "--port must be an integer between 1 and 65535."],
  [
    ["cron.status", { url: "ws://127.0.0.1:19083", port: "19083" }],
    "Use either --url or --port, not both.",
  ],
  [
    ["cron.status", { timeout: "10ms" }],
    'Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "10ms".',
  ],
  [["cron.status", { timeout: "   " }], "Invalid --timeout"],
  subagentRefusal("sessions.send"),
  subagentRefusal("sessions.steer"),
  subagentRefusal("chat.send"),
  execRefusal("sessions.send"),
  execRefusal("sessions.steer"),
  execRefusal("chat.send"),
  execRefusal("agent"),
  [["sessions.create", {}, { message: "Worker result" }], /inter-session attribution/, "exec"],
  [["sessions.create", {}, { task: "Worker task" }], /inter-session attribution/, "exec"],
  [
    ["sessions.create", {}, { attachments: [{ type: "image", content: "fixture" }] }],
    /inter-session attribution/,
    "exec",
  ],
] satisfies Refusal[])(
  "refuses %j before connecting (%s, source=%s)",
  async (args, error, source) => {
    vi.stubEnv("OPENCLAW_SHELL", source === "exec" ? "exec" : undefined);
    vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", source === "subagent" ? "1" : undefined);
    await expect(call(...args)).rejects.toThrow(error);
    expect(callGatewayMock).not.toHaveBeenCalled();
  },
);
