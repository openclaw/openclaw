// Unmocked auth-policy coverage for the shared Gateway client bootstrap owner.
import path from "node:path";
import { expect, it } from "vitest";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import { withTempHomeConfig } from "../config/test-helpers.js";
import type { GatewayRemoteConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";

function remoteGatewayConfig(remote?: GatewayRemoteConfig): OpenClawConfig {
  return { gateway: { mode: "remote", remote: { url: "wss://remote.example/ws", ...remote } } };
}

const localConfig: OpenClawConfig = {
  gateway: { mode: "local", auth: { token: "configured-auth-value" } },
};
const shellToken = { OPENCLAW_GATEWAY_TOKEN: "shell-token-value" };
const overrideUrl = "wss://override.example/rpc";
function interactive(params: Parameters<typeof resolveGatewayClientBootstrap>[0]) {
  return resolveGatewayClientBootstrap({
    env: {},
    authPolicy: "interactive",
    overrideAuthErrorHint: "Fix: pass explicit auth.",
    ...params,
  });
}

it("preserves an escaped literal credential from config load through client bootstrap", () =>
  withTempHomeConfig(
    { gateway: { mode: "local", auth: { mode: "token", token: "$${LITERAL_TOKEN}" } } },
    async ({ home: root, configPath }) => {
      const env: NodeJS.ProcessEnv = {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        VITEST: "true",
      };
      const context = createConfigIoContext({
        configPath,
        env,
        homedir: () => root,
        observe: false,
      });
      const snapshot = await readConfigFileSnapshotFromContext(context);
      const result = await resolveGatewayClientBootstrap({ config: snapshot.config, env });
      expect(result.auth).toEqual({ token: "${LITERAL_TOKEN}", password: undefined });
    },
  ));

it("reports an unresolved remote token ref instead of substituting ambient auth", async () => {
  const result = await interactive({
    config: remoteGatewayConfig({
      token: { source: "env", provider: "default", id: "ABSENT_BOOTSTRAP_REMOTE_TOKEN" },
    }),
    env: shellToken,
  });

  expect(result.auth).toEqual({ token: undefined, password: undefined });
  expect(result.authFailureReason).toContain("gateway.remote.token SecretRef is unresolved");
});

it.each([
  ["CLI", { gatewayUrl: overrideUrl, env: shellToken }, undefined],
  [
    "environment",
    { env: { OPENCLAW_GATEWAY_URL: overrideUrl, ...shellToken } },
    "shell-token-value",
  ],
  [
    "explicit credentials",
    { gatewayUrl: overrideUrl, env: shellToken, explicitAuth: { token: "caller-auth-value" } },
    "caller-auth-value",
  ],
] as const)("limits URL override credentials to %s", async (_source, params, token) => {
  const result = interactive({ config: localConfig, ...params });
  if (token === undefined) {
    await expect(result).rejects.toThrow("gateway url override requires explicit credentials");
  } else {
    expect((await result).auth).toEqual({ token, password: undefined });
  }
});

it("allows stored auth only for the exact normalized URL origin", async () => {
  const bootstrap = (gatewayUrl: string) =>
    interactive({
      config: { gateway: { mode: "local" } },
      gatewayUrl,
      allowStoredOriginAuth: async (scope) => scope === "wss://override.example/rpc",
      overrideAuthErrorHint: "Fix: pair this origin.",
    });
  await expect(bootstrap("wss://override.example/rpc/?ignored=1")).resolves.toMatchObject({
    deviceAuthScope: "wss://override.example/rpc",
    auth: { token: undefined, password: undefined },
  });
  await expect(bootstrap("wss://other.example/rpc")).rejects.toThrow(
    "gateway url override requires explicit credentials",
  );
});
