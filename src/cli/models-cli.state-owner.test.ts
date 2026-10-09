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
vi.mock("../config/config.js", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));
// mock-isolation: Supply inert key input without reading the test runner's terminal.
vi.mock("../commands/models/auth-gateway.js", () => ({
  readGatewayApiKeyParams: mocks.readKey,
}));
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
  const root = roots.make("models-auth-owner-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(
  [
    ["add"],
    ["list"],
    ["activate", "synthetic:manual"],
    ["logout", "synthetic:manual", "--yes"],
    ["setup-token", "--provider", "synthetic"],
    ["paste-token", "--provider", "synthetic"],
    ["order", "get", "--provider", "synthetic"],
    ["order", "set", "--provider", "synthetic", "synthetic:manual"],
    ["order", "clear", "--provider", "synthetic"],
  ].map((args) => ({ command: args.join(" "), args })),
)(
  "refuses models auth $command before config or credential admission when the Gateway owns state",
  async ({ args }) => {
    const program = new Command().enablePositionalOptions();
    registerModelsCli(program);
    await expect(
      program.parseAsync(["models", "auth", ...args], { from: "user" }).then(() => undefined),
    ).rejects.toMatchObject({
      code: "OWNER_UNAVAILABLE",
      message: expect.stringContaining("stop the Gateway"),
    });
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.domain).not.toHaveBeenCalled();
  },
);

it("delegates paste-api-key to the live owner without local credential admission", async () => {
  const program = new Command().enablePositionalOptions();
  registerModelsCli(program);
  await program.parseAsync(["models", "auth", "paste-api-key", "--provider", "openai"], {
    from: "user",
  });
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
  expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
  expect(mocks.domain).not.toHaveBeenCalled();
});

it.each([["login", "--provider", "fixture", "--method", "device"], ["login-github-copilot"]])(
  "delegates %j without loading local credential state",
  async (...args) => {
    const program = new Command().enablePositionalOptions();
    registerModelsCli(program);
    await program.parseAsync(["models", "--agent", "writer", "auth", ...args], { from: "user" });
    expect(mocks.gateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "models.authLogin",
        params: {
          sessionId: expect.any(String),
          authChoice: "fixture/device",
          agentId: "writer",
          expectedOwnerId: "synthetic-gateway-owner",
        },
        requiredCapabilities: ["local-state-owner-routing-v1", "models-auth-login-owner-v1"],
        scopes: ["operator.admin"],
        onResponse: expect.any(Function),
        onSignalAbort: expect.any(Function),
      }),
    );
    expect(mocks.readLogin).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "writer" }),
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(mocks.domain).not.toHaveBeenCalled();
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
  },
);

it.each(["--profile-id", "--force", "--set-default"])(
  "refuses unrepresentable login option %s before dispatch",
  async (option) => {
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      throw new ExitError(code);
    });
    const program = new Command().enablePositionalOptions();
    registerModelsCli(program);
    await expect(
      program.parseAsync(
        ["models", "auth", "login", option, ...(option === "--profile-id" ? ["custom"] : [])],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cannot be represented"));
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect(mocks.domain).not.toHaveBeenCalled();
    expect(mocks.readLogin).not.toHaveBeenCalled();
  },
);

it("cancels API-key input without calling the Gateway or admitting local credentials", async () => {
  mocks.readKey.mockRejectedValueOnce(new ExitError(0));
  const program = new Command().enablePositionalOptions();
  registerModelsCli(program);
  await expect(
    program.parseAsync(["models", "auth", "paste-api-key", "--provider", "openai"], {
      from: "user",
    }),
  ).rejects.toMatchObject({ code: 0 });
  expect(mocks.gateway).not.toHaveBeenCalled();
  expect(mocks.domain).not.toHaveBeenCalled();
  expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
});

it("does not fall back locally when the Gateway lacks owner-bound API-key support", async () => {
  mocks.gateway.mockRejectedValueOnce(
    new Error('Gateway does not support required capability "models-auth-set-api-key-owner-v1"'),
  );
  const program = new Command().enablePositionalOptions();
  registerModelsCli(program);
  await expect(
    program.parseAsync(["models", "auth", "paste-api-key", "--provider", "openai"], {
      from: "user",
    }),
  ).rejects.toMatchObject({
    code: "OWNER_REFUSED",
    message: expect.stringContaining("Update the Gateway"),
  });
  expect(mocks.domain).not.toHaveBeenCalled();
  expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
});

it.each([
  {
    name: "API-key",
    args: ["paste-api-key", "--provider", "openai"],
    method: "models.authSetApiKey",
  },
  {
    name: "login",
    args: ["login", "--provider", "openai", "--method", "api-key"],
    method: "models.authLogin",
  },
])(
  "uses the real auth-none resolver for an owner-bound $name command",
  async ({ args, method }) => {
    const { resolveGatewayCallDeviceAuth } = await import("../gateway/call-device-auth.js");
    mocks.gateway.mockImplementationOnce(async (opts) => {
      expect(opts.method).toBe(method);
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
    const program = new Command().enablePositionalOptions();
    registerModelsCli(program);
    await program.parseAsync(["models", "auth", ...args], {
      from: "user",
    });
    expect(mocks.domain).not.toHaveBeenCalled();
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
  },
);
