import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  GatewaySecretRefUnavailableError,
  resolveGatewayCredentialsFromConfig,
} from "../gateway/credentials.js";
import {
  readGatewayDispatchConfig,
  readGatewayDispatchConfigWithShellEnvFallback,
} from "./gateway-dispatch-config.js";

const shellEnvMocks = vi.hoisted(() => ({
  loadShellEnvFallback: vi.fn(),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 50),
  shouldDeferShellEnvFallback: vi.fn(() => false),
  shouldEnableShellEnvFallback: vi.fn(() => false),
}));

vi.mock("../infra/shell-env.js", () => shellEnvMocks);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  shellEnvMocks.loadShellEnvFallback.mockReset().mockReturnValue([]);
  shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReset().mockReturnValue(50);
  shellEnvMocks.shouldDeferShellEnvFallback.mockReset().mockReturnValue(false);
  shellEnvMocks.shouldEnableShellEnvFallback.mockReset().mockReturnValue(false);
});

function configFile(config: unknown, base?: string): string {
  const dir = tempDirs.make("openclaw-gateway-dispatch-config-");
  const configPath = path.join(dir, "openclaw.json5");
  if (base !== undefined) {
    fs.writeFileSync(path.join(dir, "gateway-base.json5"), base);
  }
  fs.writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
  return configPath;
}

afterEach(() => vi.restoreAllMocks());

it("reads only gateway dispatch fields from JSON5 config with includes and env vars", () => {
  const configPath = configFile(
    `{
      $include: "./gateway-base.json5",
      env: { vars: { OPENCLAW_GATEWAY_TOKEN: "inline-token" } },
      agents: { defaults: { timeoutSeconds: 42 }, entries: { ops: {} } },
      plugins: { allow: ["vault"], entries: { vault: { enabled: true } },
        load: { paths: ["./plugins/vault"] } },
      session: { mainKey: "main-ops", store: "./sessions.json" },
    }`,
    `{
      gateway: { port: 18888, auth: { mode: "token", token: "\${OPENCLAW_GATEWAY_TOKEN}" } },
      models: { providers: { expensive: { apiKey: "\${MISSING_MODEL_KEY}" } } },
    }`,
  );
  const env = { OPENCLAW_CONFIG_PATH: configPath };
  const config = readGatewayDispatchConfig({ env });
  expect(config).toMatchObject({
    gateway: { port: 18888, auth: { mode: "token", token: "inline-token" } },
    agents: { defaults: { timeoutSeconds: 42 } },
    session: { mainKey: "main" },
  });
  expect(config.agents?.entries).toEqual({ ops: {} });
  expect(config.plugins).toEqual({
    allow: ["vault"],
    entries: { vault: { enabled: true } },
    load: { paths: ["./plugins/vault"] },
  });
  expect((config as { models?: unknown }).models).toBeUndefined();
  expect(shellEnvMocks.loadShellEnvFallback).not.toHaveBeenCalled();
});

it("keeps the database engine config that store-backed credentials read", () => {
  const database = {
    postgres: { connection: { source: "file", provider: "pgdsn", id: "value" } },
    families: { state: { engine: "postgres" } },
  };
  const configPath = configFile({ gateway: { port: 18888 }, database });

  expect(readGatewayDispatchConfig({ configPath, env: {} }).database).toEqual(database);
});

it("still reports broken includes in discarded config branches", () => {
  const configPath = configFile(
    '{ gateway: { port: 18888 }, models: { $include: "./missing-models.json5" } }',
  );

  expect(() => readGatewayDispatchConfig({ configPath, env: {} })).toThrow(
    "Failed to read include file: ./missing-models.json5",
  );
});

it.each([
  ["escaped", "$${TOKEN}", {}, "${TOKEN}"],
  ["environment-resolved", "${GATEWAY_SECRET}", { GATEWAY_SECRET: "${TOKEN}" }, "${TOKEN}"],
  ["unresolved", "${MISSING_TOKEN}", {}, undefined],
  ["embedded unresolved", "prefix-${MISSING_TOKEN}", {}, undefined],
] as const)("handles %s credentials through session defaults", (_name, token, env, expected) => {
  const configPath = configFile({
    gateway: { auth: { mode: "token", token } },
    session: { mainKey: "custom" },
  });
  const config = readGatewayDispatchConfig({ configPath, env });
  const credentials = () => resolveGatewayCredentialsFromConfig({ cfg: config, env });
  if (expected === undefined) {
    expect(credentials).toThrow(GatewaySecretRefUnavailableError);
  } else {
    expect(credentials()).toEqual({ token: expected, password: undefined });
    expect(config.session?.mainKey).toBe("main");
  }
});

it.each([
  { name: "disabled", enabled: false, deferred: false },
  { name: "deferred", enabled: true, deferred: true },
  { name: "unchanged", enabled: true, deferred: false },
])("reads config once when shell fallback is $name", async ({ enabled, deferred }) => {
  const configPath = configFile({ gateway: { port: 18888 } });
  shellEnvMocks.shouldEnableShellEnvFallback.mockReturnValue(enabled);
  shellEnvMocks.shouldDeferShellEnvFallback.mockReturnValue(deferred);
  const readFile = vi.spyOn(fs, "readFileSync");
  const config = await readGatewayDispatchConfigWithShellEnvFallback({ configPath, env: {} });
  expect(config.gateway?.port).toBe(18888);
  expect(readFile.mock.calls.filter(([file]) => file === configPath)).toHaveLength(1);
});

it("loads only gateway credential shell env keys on explicit fallback", async () => {
  const configPath = configFile({
    env: { shellEnv: { enabled: true, timeoutMs: 123 } },
    gateway: { auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" } },
  });
  const env: NodeJS.ProcessEnv = { OPENCLAW_CONFIG_PATH: configPath };
  shellEnvMocks.loadShellEnvFallback.mockImplementation(({ env: targetEnv }) => {
    targetEnv.OPENCLAW_GATEWAY_TOKEN = "shell-token";
    return ["OPENCLAW_GATEWAY_TOKEN"];
  });
  const config = await readGatewayDispatchConfigWithShellEnvFallback({ env });
  expect(shellEnvMocks.loadShellEnvFallback).toHaveBeenCalledWith({
    env,
    expectedKeys: ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"],
    timeoutMs: 123,
  });
  expect(config.gateway?.auth).toMatchObject({ mode: "token", token: "shell-token" });
});
