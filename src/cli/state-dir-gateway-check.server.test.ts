import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import * as gatewayCall from "../gateway/call.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { stateDirGatewayFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { checkCliGatewayStateDir, type GatewayHello } from "./state-dir-gateway-check.js";

describe("state-dir guard with a real token Gateway", () => {
  const token = "state-dir-test-token";
  let gateway: OpenClawTestInstance;
  let hello: GatewayHello | undefined;
  const check = (authenticated = true) =>
    checkCliGatewayStateDir({
      command: "openclaw channels add",
      config: {
        gateway: {
          mode: "local",
          port: gateway.port,
          auth: { mode: "token", ...(authenticated ? { token } : {}) },
        },
      },
    });

  const setCliStateDir = (stateDir: string) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  };

  beforeAll(async () => {
    gateway = await createOpenClawTestInstance({
      name: "state-dir-server",
      entrypoint: resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(stateDirGatewayFixtureEntrypoint),
      ),
      gatewayCommandPrefix: [process.execPath],
      gatewayToken: token,
      config: { gateway: { mode: "local" }, hooks: { enabled: false } },
      env: { OPENCLAW_TEST_GATEWAY_TOKEN: token, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    gateway.env.OPENCLAW_GATEWAY_PORT = String(gateway.port);
    await gateway.startGateway();
  }, 120_000);

  beforeEach(() => {
    vi.stubEnv("HOME", path.join(gateway.state.root, "cli-home"));
    setCliStateDir(gateway.state.root);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", String(gateway.port));
    vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", `openclaw-state-dir-server-${process.pid}`);
    hello = undefined;
    const callGateway = gatewayCall.callGateway;
    vi.spyOn(gatewayCall, "callGateway").mockImplementation((options) =>
      callGateway({
        ...options,
        onHelloOk(value) {
          hello = value;
          options.onHelloOk?.(value);
        },
      }),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    vi.unstubAllEnvs();
    await gateway.cleanup();
  });

  it("allows matching authenticated hello paths", async () => {
    setCliStateDir(gateway.stateDir);
    await expect(check()).resolves.toEqual({ kind: "allow" });
    expect(hello).toMatchObject({
      snapshot: {
        stateDir: gateway.stateDir,
        configPath: path.join(gateway.stateDir, "openclaw.json"),
      },
      auth: { scopes: expect.arrayContaining(["operator.admin"]) },
    });
  });

  it("refuses mismatched authenticated hello paths", async () => {
    const outcome = await check();

    expect(outcome).toMatchObject({
      kind: "refuse",
      message: expect.stringContaining(gateway.stateDir),
    });
    expect(outcome).toHaveProperty("message", expect.stringContaining("live Gateway"));
  });

  it.skipIf(process.platform !== "win32")(
    "runs the suggested PowerShell repair command for a real Gateway mismatch",
    async () => {
      const cliStateDir = path.join(gateway.stateDir, "cli-state");
      setCliStateDir(cliStateDir);
      const outcome = await check();
      if (outcome.kind !== "refuse") {
        throw new Error("expected authenticated path mismatch refusal");
      }
      const suggested = /Fix: in PowerShell, run (.+?)\. To write another local store/u.exec(
        outcome.message,
      )?.[1];
      if (!suggested) {
        throw new Error(`expected executable repair command: ${outcome.message}`);
      }
      const script = [
        '$ErrorActionPreference = "Stop"',
        "$env:OPENCLAW_STATE_DIR = 'outer-state'",
        "$env:OPENCLAW_CONFIG_PATH = 'outer-config'",
        'function openclaw { Write-Output "INSIDE=$env:OPENCLAW_STATE_DIR|$env:OPENCLAW_CONFIG_PATH" }',
        suggested,
        'Write-Output "AFTER=$env:OPENCLAW_STATE_DIR|$env:OPENCLAW_CONFIG_PATH"',
      ].join("\n");
      const result = spawnSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `INSIDE=${gateway.stateDir}|${path.join(gateway.stateDir, "openclaw.json")}`,
      );
      expect(result.stdout).toContain("AFTER=outer-state|outer-config");
    },
  );

  it("warns when a tokenless CLI can prove only the Gateway protocol", async () => {
    await expect(check(false)).resolves.toMatchObject({ kind: "warn" });
  });
});
