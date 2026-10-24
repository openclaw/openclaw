import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import { registerModelsCli } from "./models-cli.js";

const mocks = vi.hoisted(() => ({
  domain: vi.fn(async () => undefined),
  getRuntimeConfig: vi.fn(() => ({})),
  gateway: vi.fn(async (_opts: CallGatewayOptions) => ({
    provider: "openai",
    profileId: "openai:manual",
  })),
  readKey: vi.fn(async () => ({ provider: "openai", apiKey: "synthetic-api-key" })),
  readLogin: vi.fn(async (_opts: { agent?: string }, sessionId: string) => ({
    sessionId,
    authChoice: "fixture/device",
    agentId: _opts.agent,
  })),
  wizard: vi.fn(async () => {}),
}));

// mock-isolation: A delegated command must not initialize mutation-capable config.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  loadConfig: mocks.getRuntimeConfig,
  captureRuntimeConfigAsyncReader: () => async () => mocks.getRuntimeConfig(),
}));
// mock-isolation: Supply inert key input without reading the test runner's terminal.
vi.mock("../commands/models/auth-gateway.js", () => ({ readGatewayApiKeyParams: mocks.readKey }));
// mock-isolation: Routing tests must not prompt for or execute provider authentication.
vi.mock("../commands/models/auth-login-gateway.js", () => ({
  readGatewayLoginParams: mocks.readLogin,
  runGatewayLoginWizard: mocks.wizard,
}));
// mock-isolation: Observe owner routing without connecting to a real Gateway.
vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.gateway,
  isGatewayClientRequestError: () => false,
}));
vi.mock("../infra/gateway-state-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-state-owner.js")>()),
  captureGatewayStateOwner: () => undefined,
}));
vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockIdentity: async () => ({
    pid: process.pid + 1,
    ownerId: "synthetic-gateway-owner",
    port: 18789,
  }),
}));
// mock-isolation: Refusal must precede provider prompts, config loads, and store access.
vi.mock("../commands/models/auth.js", () => ({
  modelsAuthAddCommand: mocks.domain,
  modelsAuthLoginCommand: mocks.domain,
  modelsAuthPasteApiKeyCommand: mocks.domain,
  modelsAuthPasteTokenCommand: mocks.domain,
  modelsAuthSetupTokenCommand: mocks.domain,
}));
// mock-isolation: Refusal must precede provider prompts, config loads, and store access.
vi.mock("../commands/models/auth-list.js", () => ({ modelsAuthListCommand: mocks.domain }));
// mock-isolation: Refusal must precede provider prompts, config loads, and store access.
vi.mock("../commands/models/auth-activate.js", () => ({ modelsAuthActivateCommand: mocks.domain }));
// mock-isolation: Refusal must precede provider prompts, config loads, and store access.
vi.mock("../commands/models/auth-logout.js", () => ({ modelsAuthLogoutCommand: mocks.domain }));
// mock-isolation: Refusal must precede provider prompts, config loads, and store access.
vi.mock("../commands/models/auth-order.js", () => ({
  modelsAuthOrderGetCommand: mocks.domain,
  modelsAuthOrderUpdateCommand: mocks.domain,
}));

const roots = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.clearAllMocks();
  // Exercise auth-none resolution inside the same owner dispatch that verifies its RPC envelope.
  mocks.gateway.mockImplementation(async (opts) => {
    const { resolveGatewayCallDeviceAuth } = await import("../gateway/call-device-auth.js");
    const resolved = await resolveGatewayCallDeviceAuth({
      opts,
      url: `ws://127.0.0.1:${opts.localPortOverride}`,
      authMode: "none",
      isImplicitLocalTarget: true,
    });
    expect(resolved.clientOptions).toMatchObject({
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      requireLocalBackendSharedAuth: true,
    });
    expect(resolved.deviceIdentity).toBeNull();
    return { provider: "openai", profileId: "openai:manual" };
  });
  const root = roots.make("models-auth-owner-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function runAuth(args: string | string[]) {
  const program = new Command().enablePositionalOptions();
  registerModelsCli(program);
  await program.parseAsync(["models", ...(typeof args === "string" ? args.split(" ") : args)], {
    from: "user",
  });
}

function expectNoLocalAdmission() {
  expect(mocks.domain).not.toHaveBeenCalled();
  expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
}

it.each([
  "add",
  "list",
  "activate synthetic:manual",
  "logout synthetic:manual --yes",
  "setup-token --provider synthetic",
  "paste-token --provider synthetic",
  "order get --provider synthetic",
  "order set --provider synthetic synthetic:manual",
  "order clear --provider synthetic",
])(
  "refuses models auth %s before config or credential admission when the Gateway owns state",
  async (args) => {
    await expect(runAuth(`auth ${args}`)).rejects.toMatchObject({
      code: "OWNER_UNAVAILABLE",
      message: expect.stringContaining("stop the Gateway"),
    });
    expect(mocks.gateway).not.toHaveBeenCalled();
    expectNoLocalAdmission();
  },
);

it("delegates paste-api-key to the live owner without local credential admission", async () => {
  await runAuth("auth paste-api-key --provider openai");
  expect(mocks.gateway).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "models.authSetApiKey",
      params: {
        provider: "openai",
        apiKey: "synthetic-api-key",
        expectedOwnerId: "synthetic-gateway-owner",
      },
      localPortOverride: 18789,
      ignoreEnvUrlOverride: true,
      requireLocalBackendSharedAuth: true,
      allowLocalBackendAuthNone: true,
      scopes: ["operator.admin"],
      requiredCapabilities: ["local-state-owner-routing-v1", "models-auth-set-api-key-owner-v1"],
      assertDispatchCurrent: expect.any(Function),
    }),
  );
  expect(mocks.readKey).toHaveBeenCalledWith(
    { provider: "openai", agent: undefined },
    expect.any(AbortSignal),
  );
  expectNoLocalAdmission();
});

it.each([
  [["login", "--provider", "fixture", "--method", "device"], "writer"],
  [["login-github-copilot"], "writer"],
  [["login", "--provider", "openai", "--method", "api-key"], undefined],
] as const)("delegates %j without loading local credential state", async (args, agent) => {
  await runAuth([...(agent ? ["--agent", agent] : []), "auth", ...args]);
  expect(mocks.gateway).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "models.authLogin",
      params: {
        sessionId: expect.any(String),
        authChoice: "fixture/device",
        agentId: agent,
        expectedOwnerId: "synthetic-gateway-owner",
      },
      requiredCapabilities: ["local-state-owner-routing-v1", "models-auth-login-owner-v1"],
      scopes: ["operator.admin"],
      onResponse: expect.any(Function),
      onSignalAbort: expect.any(Function),
    }),
  );
  expect(mocks.readLogin).toHaveBeenCalledWith(
    expect.objectContaining({ agent }),
    expect.any(String),
    expect.any(AbortSignal),
  );
  expectNoLocalAdmission();
});

it.each(["--profile-id", "--force", "--set-default"])(
  "refuses unrepresentable login option %s before dispatch",
  async (option) => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new ExitError(code);
    });
    await expect(
      runAuth(["auth", "login", option, ...(option === "--profile-id" ? ["custom"] : [])]),
    ).rejects.toMatchObject({ code: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cannot be represented"));
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect(mocks.domain).not.toHaveBeenCalled();
    expect(mocks.readLogin).not.toHaveBeenCalled();
  },
);

it.each([
  [true, new ExitError(0), { code: 0 }],
  [
    false,
    new Error('Gateway does not support required capability "models-auth-set-api-key-owner-v1"'),
    { code: "OWNER_REFUSED", message: expect.stringContaining("Update the Gateway") },
  ],
] as const)(
  "does not admit credentials (input cancellation=%s)",
  async (input, error, expected) => {
    (input ? mocks.readKey : mocks.gateway).mockRejectedValueOnce(error);
    await expect(runAuth("auth paste-api-key --provider openai")).rejects.toMatchObject(expected);
    if (input) {
      expect(mocks.gateway).not.toHaveBeenCalled();
    }
    expectNoLocalAdmission();
  },
);
