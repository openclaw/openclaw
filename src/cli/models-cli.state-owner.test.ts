import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerModelsCli } from "./models-cli.js";

const mocks = vi.hoisted(() => ({
  domain: vi.fn(async () => undefined),
  getRuntimeConfig: vi.fn(() => ({})),
}));

// mock-isolation: A refused command must not initialize mutation-capable config.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));
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
    ["login", "--provider", "synthetic"],
    ["login", "--provider", "synthetic", "--force"],
    ["login-github-copilot"],
    ["setup-token", "--provider", "synthetic"],
    ["paste-token", "--provider", "synthetic"],
    ["paste-api-key", "--provider", "synthetic"],
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
    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.domain).not.toHaveBeenCalled();
  },
);
