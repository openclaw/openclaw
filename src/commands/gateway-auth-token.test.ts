import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { gatewayAuthTokenCommand } from "./gateway-auth-token.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

const tokenRef = { source: "env", provider: "default", id: "GATEWAY_TOKEN" } as const;
const tokenConfig = { gateway: { auth: { mode: "token", token: tokenRef } } } as const;
function setConfig(sourceConfig: OpenClawConfig) {
  mocks.readConfigFileSnapshot.mockResolvedValue({ valid: true, sourceConfig, config: {} });
}
function setResolvedConfig(resolvedConfig: OpenClawConfig) {
  mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
    resolvedConfig,
    diagnostics: [],
    targetStatesByPath: { "gateway.auth.token": "resolved_gateway" },
    hadUnresolvedTargets: false,
  });
}
async function expectRefusal(message: string, env: NodeJS.ProcessEnv = {}) {
  await expect(gatewayAuthTokenCommand(runtime, { env, interactive: true })).rejects.toThrow(
    message,
  );
  expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  expect(runtime.writeStdout).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig(tokenConfig);
  setResolvedConfig({ gateway: { auth: { mode: "token", token: "resolved-value" } } });
});

it("prints only the resolved token for an interactive operator", async () => {
  const env = { OPENCLAW_GATEWAY_TOKEN: "environment-value" };

  await gatewayAuthTokenCommand(runtime, { env, interactive: true });

  expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
    config: tokenConfig,
    commandName: "gateway auth-token",
    targetIds: new Set(["gateway.auth.token"]),
    mode: "enforce_resolved",
    allowedPaths: new Set(["gateway.auth.token"]),
  });
  expect(runtime.writeStdout).toHaveBeenCalledWith("resolved-value\n");
  expect(runtime.log).not.toHaveBeenCalled();
  expect(runtime.error).not.toHaveBeenCalled();
});

it("diagnoses a redaction marker returned by an older Gateway instead of revealing it", async () => {
  setResolvedConfig({ gateway: { auth: { mode: "token", token: "__OPENCLAW_REDACTED__" } } });
  await expect(gatewayAuthTokenCommand(runtime, { env: {}, interactive: true })).rejects.toThrow(
    "openclaw doctor --fix",
  );
  expect(runtime.writeStdout).not.toHaveBeenCalled();
});

it("refuses non-interactive output before reading config or secrets", async () => {
  await expect(gatewayAuthTokenCommand(runtime, { interactive: false })).rejects.toThrow(
    "outside an interactive terminal",
  );

  expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
  expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  expect(runtime.writeStdout).not.toHaveBeenCalled();
});

it("fails actionably when no configured token is available", async () => {
  setConfig({ gateway: { auth: { mode: "token" } } });
  setResolvedConfig({ gateway: { auth: { mode: "token" } } });

  await expect(gatewayAuthTokenCommand(runtime, { env: {}, interactive: true })).rejects.toThrow(
    "openclaw doctor --generate-gateway-token",
  );

  expect(runtime.writeStdout).not.toHaveBeenCalled();
});

it("does not fall back to ambient env when the configured SecretRef is unresolved", async () => {
  mocks.resolveCommandSecretRefsViaGateway.mockRejectedValue(
    new Error("gateway.auth.token SecretRef is unresolved"),
  );

  await expect(
    gatewayAuthTokenCommand(runtime, {
      interactive: true,
      env: { OPENCLAW_GATEWAY_TOKEN: "ambient-fallback" },
    }),
  ).rejects.toThrow("gateway.auth.token SecretRef is unresolved");

  expect(runtime.writeStdout).not.toHaveBeenCalled();
});

it("refuses an inactive token when auth mode is trusted-proxy", async () => {
  setConfig({
    gateway: {
      auth: { mode: "trusted-proxy", token: "stale-token", password: "active-password" },
    },
  });
  await expectRefusal("Gateway auth mode is trusted-proxy");
});

it("requires an explicit mode when token and password are both configured", async () => {
  setConfig({ gateway: { auth: { token: "candidate-token", password: "candidate-password" } } });
  await expectRefusal("gateway.auth.mode");
});

it("does not reveal a configured token when an environment password selects password auth", async () => {
  setConfig({ gateway: { auth: { token: "inactive-token" } } });
  await expectRefusal("Gateway auth mode is password", {
    OPENCLAW_GATEWAY_PASSWORD: "active-password",
  });
});

it("refuses to recover credentials from a remote-client config", async () => {
  setConfig({ gateway: { mode: "remote", auth: { mode: "token", token: "stale-local-token" } } });
  await expectRefusal("must run on the Gateway host");
});
