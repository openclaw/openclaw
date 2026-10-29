import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addGatewayClientOptions } from "./gateway-rpc.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";

const callGatewayMock = vi.fn(async () => ({ ok: true }));
// mock-isolation: Exercise CLI request construction without a real Gateway connection.
vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
  isImplicitLocalGatewayTarget: vi.fn(async () => true),
}));
vi.mock("./progress.js", () => ({
  withProgress: async (_options: unknown, action: () => Promise<unknown>) => await action(),
}));
const { callGatewayFromCliRuntime: call } = await import("./gateway-rpc.runtime.js");
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

it.each([
  ["url", "wss://gateway.example/ws", { url: "wss://gateway.example/ws" }],
  ["port", "19083", { localPortOverride: 19083 }],
] as const)("parses authentication and --%s", async (option, value, expected) => {
  const program = new Command().exitOverride();
  addGatewayClientOptions(program.command("gateway-command")).action((opts: GatewayRpcOpts) =>
    call("cron.status", opts),
  );
  await program.parseAsync(["gateway-command", `--${option}`, value, ...credentials], {
    from: "user",
  });
  expectCall({ ...expected, ...auth });
});

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
  signal: new AbortController().signal,
} satisfies NonNullable<Parameters<typeof call>[3]>;
const message = { key: "agent:main:main", message: "Human request" };
type CallArgs = Parameters<typeof call>;
type Source = "exec" | "subagent";
type Forwarding = [args: CallArgs, expected: Record<string, unknown>, source?: Source];
const timeoutCase = (
  timeout: string | undefined,
  defaultTimeoutMs: number | undefined,
  timeoutMs: number,
): Forwarding => [
  ["cron.status", { timeout }, undefined, { defaultTimeoutMs }],
  { method: "cron.status", timeoutMs },
];
const forwardingCases: Forwarding[] = [
  timeoutCase(undefined, undefined, 30_000),
  timeoutCase(undefined, 10_000, 10_000),
  timeoutCase("15000", 600_000, 15_000),
  [["node.list", target, {}, extra], { ...target, ...extra }],
  [["sessions.send", {}, message], { method: "sessions.send", params: message }],
  [["sessions.history", {}, message], { method: "sessions.history", params: message }, "subagent"],
  [["health", {}, message], { method: "health", params: message }, "exec"],
  [["sessions.create", {}, { key: "agent:main:empty", message: " ", attachments: [] }], {}, "exec"],
];
it.for(forwardingCases)("forwards %j", async ([args, expected, source]) => {
  vi.stubEnv("OPENCLAW_SHELL", source === "exec" ? "exec" : undefined);
  vi.stubEnv("OPENCLAW_SUBAGENT_EXEC", source === "subagent" ? "1" : undefined);
  await call(...args);
  expectCall(expected);
});

type Refusal = [args: CallArgs, error: string | RegExp, source?: Source];
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
