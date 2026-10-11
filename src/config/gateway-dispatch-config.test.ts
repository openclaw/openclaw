// Covers gateway dispatch config loading and fallback behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const tempDirs: string[] = [];

beforeEach(() => {
  shellEnvMocks.loadShellEnvFallback.mockReset().mockReturnValue({ ok: true, applied: [] });
  shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReset().mockReturnValue(50);
  shellEnvMocks.shouldDeferShellEnvFallback.mockReset().mockReturnValue(false);
  shellEnvMocks.shouldEnableShellEnvFallback.mockReset().mockReturnValue(false);
});

function createTempConfig(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-dispatch-config-"));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return path.join(dir, "openclaw.json5");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readGatewayDispatchConfig", () => {
  it("reads only gateway dispatch fields from JSON5 config with includes and env vars", () => {
    const configPath = createTempConfig({
      "gateway-base.json5": `{
        gateway: {
          port: 18888,
          auth: { mode: "token", token: "\${OPENCLAW_GATEWAY_TOKEN}" },
        },
        models: { providers: { expensive: { apiKey: "\${MISSING_MODEL_KEY}" } } },
      }`,
      "openclaw.json5": `{
        $include: "./gateway-base.json5",
        env: { vars: { OPENCLAW_GATEWAY_TOKEN: "inline-token" } },
        agents: {
          defaults: { timeoutSeconds: 42 },
          entries: { ops: {} },
        },
        plugins: {
          allow: ["vault"],
          entries: { vault: { enabled: true } },
          load: { paths: ["./plugins/vault"] },
        },
        session: { mainKey: "main-ops", store: "./sessions.json" },
      }`,
    });
    const env = { OPENCLAW_CONFIG_PATH: configPath };

    const config = readGatewayDispatchConfig({ env });

    expect(config.gateway?.port).toBe(18888);
    expect(config.gateway?.auth).toMatchObject({ mode: "token", token: "inline-token" });
    expect(config.agents?.defaults?.timeoutSeconds).toBe(42);
    expect(config.agents?.entries).toEqual({ ops: {} });
    expect(config.plugins).toEqual({
      allow: ["vault"],
      entries: { vault: { enabled: true } },
      load: { paths: ["./plugins/vault"] },
    });
    expect(config.session?.mainKey).toBe("main");
    expect((config as { models?: unknown }).models).toBeUndefined();
    expect(shellEnvMocks.loadShellEnvFallback).not.toHaveBeenCalled();
  });

  it("still reports broken includes in discarded config branches", () => {
    const configPath = createTempConfig({
      "openclaw.json5": `{
        gateway: { port: 18888 },
        models: { $include: "./missing-models.json5" },
      }`,
    });

    expect(() => readGatewayDispatchConfig({ configPath, env: {} })).toThrow(
      "Failed to read include file: ./missing-models.json5",
    );
  });

  it.each([
    { name: "escaped", token: "$${TOKEN}", env: {}, expected: "${TOKEN}" },
    {
      name: "environment-resolved",
      token: "${GATEWAY_SECRET}",
      env: { GATEWAY_SECRET: "${TOKEN}" },
      expected: "${TOKEN}",
    },
  ])("preserves $name literal credentials through session defaults", ({ token, env, expected }) => {
    const configPath = createTempConfig({
      "openclaw.json5": JSON.stringify({
        gateway: { auth: { mode: "token", token } },
        session: { mainKey: "custom" },
      }),
    });

    const config = readGatewayDispatchConfig({ configPath, env });

    expect(resolveGatewayCredentialsFromConfig({ cfg: config, env })).toEqual({
      token: expected,
      password: undefined,
    });
    expect(config.session?.mainKey).toBe("main");
  });

  it.each(["${MISSING_TOKEN}", "prefix-${MISSING_TOKEN}"])(
    "rejects an unresolved credential %s",
    (token) => {
      const configPath = createTempConfig({
        "openclaw.json5": JSON.stringify({ gateway: { auth: { mode: "token", token } } }),
      });
      const config = readGatewayDispatchConfig({ configPath, env: {} });

      expect(() => resolveGatewayCredentialsFromConfig({ cfg: config, env: {} })).toThrow(
        GatewaySecretRefUnavailableError,
      );
    },
  );

  it.each([
    { name: "disabled", enabled: false, deferred: false },
    { name: "deferred", enabled: true, deferred: true },
    { name: "unchanged", enabled: true, deferred: false },
  ])("reads config once when shell fallback is $name", async ({ enabled, deferred }) => {
    const configPath = createTempConfig({
      "openclaw.json5": JSON.stringify({ gateway: { port: 18888 } }),
    });
    shellEnvMocks.shouldEnableShellEnvFallback.mockReturnValue(enabled);
    shellEnvMocks.shouldDeferShellEnvFallback.mockReturnValue(deferred);
    const readFile = vi.spyOn(fs, "readFileSync");

    const config = await readGatewayDispatchConfigWithShellEnvFallback({ configPath, env: {} });

    expect(config.gateway?.port).toBe(18888);
    expect(readFile.mock.calls.filter(([file]) => file === configPath)).toHaveLength(1);
  });

  it("loads only gateway credential shell env keys on explicit fallback", async () => {
    const configPath = createTempConfig({
      "openclaw.json5": `{
        env: { shellEnv: { enabled: true, timeoutMs: 123 } },
        gateway: { auth: { mode: "token", token: "\${OPENCLAW_GATEWAY_TOKEN}" } },
      }`,
    });
    const env: NodeJS.ProcessEnv = { OPENCLAW_CONFIG_PATH: configPath };
    shellEnvMocks.loadShellEnvFallback.mockImplementation(({ env: targetEnv }) => {
      targetEnv.OPENCLAW_GATEWAY_TOKEN = "shell-token";
      return { ok: true, applied: ["OPENCLAW_GATEWAY_TOKEN"] };
    });

    const config = await readGatewayDispatchConfigWithShellEnvFallback({ env });

    expect(shellEnvMocks.loadShellEnvFallback).toHaveBeenCalledWith({
      enabled: true,
      env,
      expectedKeys: ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"],
      logger: console,
      timeoutMs: 123,
    });
    expect(config.gateway?.auth).toMatchObject({ mode: "token", token: "shell-token" });
  });
});
