// Unmocked auth-policy coverage for the shared Gateway client bootstrap owner.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import type { GatewayRemoteConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function remoteGatewayConfig(remote?: GatewayRemoteConfig): OpenClawConfig {
  return { gateway: { mode: "remote", remote: { url: "wss://remote.example/ws", ...remote } } };
}

type BootstrapParams = Parameters<typeof resolveGatewayClientBootstrap>[0];
const localConfig: OpenClawConfig = {
  gateway: { mode: "local", auth: { token: "configured-auth-value" } },
};
const shellToken = { OPENCLAW_GATEWAY_TOKEN: "shell-token-value" };
const overrideUrl = "wss://override.example/rpc";
function interactive(params: BootstrapParams) {
  return resolveGatewayClientBootstrap({
    env: {},
    authPolicy: "interactive",
    overrideAuthErrorHint: "Fix: pass explicit auth.",
    ...params,
  });
}

async function loadLocalTokenConfig(token: string) {
  const root = tempDirs.make("openclaw-client-bootstrap-literal-");
  const configPath = path.join(root, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    VITEST: "true",
  };
  fs.writeFileSync(
    configPath,
    JSON.stringify({ gateway: { mode: "local", auth: { mode: "token", token } } }),
    "utf8",
  );
  const context = createConfigIoContext({ configPath, env, homedir: () => root, observe: false });
  const snapshot = await readConfigFileSnapshotFromContext(context);
  return { config: snapshot.config, env };
}

it("preserves an escaped literal credential from config load through client bootstrap", async () => {
  const params = await loadLocalTokenConfig("$${LITERAL_TOKEN}");
  const result = await resolveGatewayClientBootstrap(params);

  expect(result.auth).toEqual({ token: "${LITERAL_TOKEN}", password: undefined });
});

it.each([
  ["local", "local-config-auth-value", "local-config-auth-value"],
  ["local", undefined, "shell-password-value"],
  ["remote", undefined, "shell-token-value"],
  ["remote", "remote-config-auth-value", "remote-config-auth-value"],
] as const)("resolves %s auth (configured=%s)", async (mode, configured, expected) => {
  const local = mode === "local";
  const result = await interactive({
    config: local
      ? { gateway: { mode, auth: { mode: "password", password: configured } } }
      : remoteGatewayConfig({ token: configured }),
    env: local ? { OPENCLAW_GATEWAY_PASSWORD: "shell-password-value" } : shellToken,
  });
  expect(result.auth).toEqual({
    token: local ? undefined : expected,
    password: local ? expected : undefined,
  });
  expect(result).not.toHaveProperty("authFailureReason");
});

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

it("never reuses config or env credentials for a CLI URL override", async () => {
  await expect(
    interactive({ config: localConfig, gatewayUrl: overrideUrl, env: shellToken }),
  ).rejects.toThrow("gateway url override requires explicit credentials");
});

it("uses only env credentials for an env URL override", async () => {
  const result = await interactive({
    config: localConfig,
    env: { OPENCLAW_GATEWAY_URL: overrideUrl, ...shellToken },
  });

  expect(result.auth).toEqual({ token: "shell-token-value", password: undefined });
});

it("keeps explicit credentials ahead of every implicit source", async () => {
  const result = await interactive({
    config: localConfig,
    gatewayUrl: overrideUrl,
    explicitAuth: { token: "caller-auth-value" },
    env: shellToken,
  });

  expect(result.auth).toEqual({ token: "caller-auth-value", password: undefined });
});

it("allows stored auth only for the exact normalized URL origin", async () => {
  const seenScopes: string[] = [];
  await expect(
    interactive({
      config: { gateway: { mode: "local" } },
      gatewayUrl: "wss://override.example/rpc/?ignored=1",
      allowStoredOriginAuth: async (scope) => {
        seenScopes.push(scope);
        return scope === "wss://override.example/rpc";
      },
      overrideAuthErrorHint: "Fix: pair this origin.",
    }),
  ).resolves.toMatchObject({
    deviceAuthScope: "wss://override.example/rpc",
    auth: { token: undefined, password: undefined },
  });
  expect(seenScopes).toEqual(["wss://override.example/rpc"]);

  await expect(
    interactive({
      config: { gateway: { mode: "local" } },
      gatewayUrl: "wss://other.example/rpc",
      allowStoredOriginAuth: async (scope) => scope === "wss://override.example/rpc",
      overrideAuthErrorHint: "Fix: pair this origin.",
    }),
  ).rejects.toThrow("gateway url override requires explicit credentials");
});
