import "../test-utils/prepare-compiled-subprocesses.js";
// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import * as f from "./run-main.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { createNewerSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getGatewayRunRuntimeHooks } from "./gateway-cli/runtime-hooks.js";
import { makeProxyHandle } from "./run-main.proxy-exit.test-support.js";

function primeConfig(...args: Parameters<typeof f.validConfig>) {
  f.readConfigFileSnapshotMock.mockResolvedValue(f.validConfig(...args));
}

function guardedConfig(source: Parameters<typeof f.validConfig>[0]) {
  return f.validConfig(source, { hash: "guarded", path: "/tmp/openclaw.json", raw: "{}" });
}
async function prepareGuarded(source: Parameters<typeof f.validConfig>[0]) {
  f.readConfigFileSnapshotMock.mockResolvedValue(guardedConfig(source));
  await f.runCli(f.cliArgs("gateway"));
  await f.runGatewayBeforeHook();
  return f.ensureCliExecutionBootstrapMock.mock.calls[0]?.[0]?.beforeStatePreparation;
}
const futureConfig = { meta: { lastTouchedVersion: "9999.1.1" } };
const serviceConfig = { ...futureConfig, env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } } };
const newerSchemaError = () =>
  createNewerSqliteSchemaVersionError(
    "OpenClaw state database",
    "/tmp/openclaw-startup/state/openclaw.sqlite",
    14,
    13,
  );
const serviceOverride = {
  OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
  OPENCLAW_SERVICE_MARKER: undefined,
};
const openClawEnv = (values: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [`OPENCLAW_${key}`, value]));
function expectEnv(values: Record<string, string | undefined>) {
  expect(
    Object.fromEntries(Object.keys(values).map((key) => [key, process.env[`OPENCLAW_${key}`]])),
  ).toEqual(values);
}
const localConfig = (vars?: Record<string, string>) => ({
  gateway: { mode: "local" as const },
  ...(vars ? { env: { vars } } : {}),
});
function selectConfig(
  select: () => boolean,
  selected: Parameters<typeof f.validConfig>[0],
  original: Parameters<typeof f.validConfig>[0] = localConfig(),
) {
  f.readConfigFileSnapshotMock.mockImplementation(async () =>
    f.validConfig(select() ? selected : original),
  );
}
function primeProxy(final: ReturnType<typeof makeProxyHandle> | null) {
  const early = makeProxyHandle();
  const config = { proxyUrl: "http://127.0.0.1:19876" };
  f.loadConfigMock.mockReturnValueOnce({ proxy: config });
  f.startProxyMock.mockResolvedValueOnce(early).mockResolvedValueOnce(final);
  return { early, config };
}

async function expectBlocked(message: string, code = 1, flags: string[] = []) {
  await f.withCliExitSpies(async (errorSpy) => {
    await expect(f.runCli(f.cliArgs("gateway", ...flags))).rejects.toMatchObject({
      name: "ExitError",
      code,
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(f.ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
  });
}

async function withGatewayHome(
  files: (home: string) => Record<string, string>,
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = f.tempDirs.make("openclaw-run-main-env-");
  for (const [relative, content] of Object.entries(files(home))) {
    const target = path.join(home, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await withEnvAsync(
    {
      HOME: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined,
      OPENCLAW_INCLUDE_ROOTS: undefined,
      NODE_OPTIONS: undefined,
    },
    () => run(home),
  );
}

describe("runCli exit behavior", () => {
  f.installRunMainTestHooks();

  it.each(["environment selection", "full Commander preaction"])(
    "parks the managed Gateway when a newer schema blocks %s",
    async (phase) => {
      const error = newerSchemaError();
      const argv = f.cliArgs("--log-level", "debug", "gateway", "run");
      if (phase === "environment selection") {
        f.readConfigFileSnapshotMock.mockRejectedValueOnce(error);
      } else {
        f.buildProgramMock.mockReturnValueOnce(
          f.makeProgram("gateway", vi.fn().mockRejectedValueOnce(error)),
        );
        f.tryRouteCliMock.mockResolvedValueOnce(false);
      }
      await f.withCliExitSpies(async (errorSpy, exitSpy) => {
        await expect(f.runCli(argv)).rejects.toMatchObject({ name: "ExitError", code: 78 });

        expect(f.parkCurrentLaunchAgentForMaintenanceMock).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledWith(78);
        expect(errorSpy.mock.calls.flat().join("\n")).toContain(error.message);
        expect(f.addGatewayRunCommandMock).not.toHaveBeenCalled();
        expect(f.buildProgramMock).toHaveBeenCalledTimes(phase === "environment selection" ? 0 : 1);
      });
    },
  );

  it.each([
    { label: "Gateway help", args: ["gateway", "--help"] },
    { label: "another command", args: ["status"] },
  ])("does not park the Gateway for a newer-schema failure during $label", async ({ args }) => {
    const error = newerSchemaError();
    f.buildProgramMock.mockReturnValueOnce(
      f.makeProgram(args[0], vi.fn().mockRejectedValueOnce(error)),
    );

    await withEnvAsync({ OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" }, async () => {
      await expect(f.runCli(f.cliArgs(...args))).rejects.toBe(error);
    });

    expect(f.parkCurrentLaunchAgentForMaintenanceMock).not.toHaveBeenCalled();
  });

  it("defers config-drift exit until readiness releases its lease", async () => {
    const before = await prepareGuarded({
      cron: { store: "/tmp/included-a.json" },
      gateway: { mode: "local" },
    });
    f.readConfigFileSnapshotMock.mockResolvedValue(
      guardedConfig({
        cron: { store: "/tmp/included-b.json" },
        gateway: { mode: "local" },
      }),
    );
    await f.withCliExitSpies(async (errorSpy, exitSpy) => {
      await expect(before?.()).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("changed during startup"));
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
  it("defers a service-mode future-config exit to readiness", async () => {
    const before = await prepareGuarded({ gateway: { mode: "local" } });
    await f.withCliExitSpies(async (errorSpy, exitSpy) => {
      await withEnvAsync(serviceOverride, async () => {
        await expect(
          before?.(
            f.validConfig(serviceConfig, {
              hash: "future",
              path: "/tmp/openclaw.json",
              raw: "{}",
            }),
          ),
        ).rejects.toMatchObject({ name: "ExitError", code: 78 });
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("start the gateway service"));
        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        expect(exitSpy).not.toHaveBeenCalled();
      });
    });
  });

  it.each([
    { flags: [], service: true, action: "start the gateway service", code: 78 },
    { flags: ["--force"], service: false, action: "force-kill gateway port listeners", code: 1 },
    { flags: ["--dev", "--reset"], service: false, action: "reset the dev gateway state", code: 1 },
  ])("blocks future config before $action", async ({ flags, service, action, code }) => {
    primeConfig(futureConfig);
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: service ? "gateway" : undefined,
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: service ? "1" : undefined,
      },
      async () => {
        await expectBlocked(action, code, flags);
        expect(f.readConfigFileSnapshotMock.mock.calls).toEqual([[f.readOnlyCoreOptions]]);
        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
      },
    );
  });

  it("blocks and revokes the destructive override when selected config declares service mode", async () => {
    primeConfig(serviceConfig);
    await withEnvAsync(serviceOverride, async () => {
      await expectBlocked("start the gateway service", 78);
      expect(process.env.OPENCLAW_SERVICE_MARKER).toBeUndefined();
      expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
    });
  });

  it("loads state dotenv before a custom config-root fallback", async () => {
    await withGatewayHome(
      () => ({
        ".openclaw/.env": "OPENCLAW_GATEWAY_TOKEN=state-token\n",
        "profile/.env":
          "OPENCLAW_GATEWAY_PASSWORD=config-root-password\nOPENCLAW_GATEWAY_TOKEN=config-root-token\n",
      }),
      async (home) => {
        process.env.OPENCLAW_CONFIG_PATH = path.join(home, "profile", "openclaw.json");
        await f.runCli(f.cliArgs("gateway"));
        expectEnv({ GATEWAY_TOKEN: "state-token", GATEWAY_PASSWORD: "config-root-password" });
      },
    );
  });

  it("re-guards config selection from a newly selected state dotenv", async () => {
    await withGatewayHome(
      (home) => ({
        "state/.env": `OPENCLAW_CONFIG_PATH=${path.join(home, "state", "future.json")}\nOPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1\n`,
      }),
      async (home) => {
        const stateDir = path.join(home, "state");
        selectConfig(
          () => process.env.OPENCLAW_CONFIG_PATH === path.join(stateDir, "future.json"),
          futureConfig,
          localConfig({ OPENCLAW_STATE_DIR: stateDir }),
        );
        await expectBlocked("run gateway state preparation");
        expect(f.readConfigFileSnapshotMock).toHaveBeenCalledTimes(2);
        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
      },
    );
  });

  it("does not apply environment variables from invalid config snapshots", async () => {
    await withEnvAsync({ OPENCLAW_INCLUDE_ROOTS: undefined }, async () => {
      f.readConfigFileSnapshotMock.mockResolvedValue({
        exists: true,
        issues: [{ message: "invalid", path: "gateway" }],
        legacyIssues: [],
        valid: false,
        sourceConfig: localConfig({ OPENCLAW_INCLUDE_ROOTS: "/tmp/openclaw-includes" }),
      });

      await f.runCli(f.cliArgs("gateway"));
      await f.runGatewayBeforeHook();

      expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
      expect(f.readConfigFileSnapshotMock.mock.calls).toEqual([
        [f.readOnlyCoreOptions],
        [f.readOnlyCoreOptions],
      ]);
      expect(f.ensureCliExecutionBootstrapMock).toHaveBeenCalledWith(
        expect.objectContaining({
          commandPath: ["gateway"],
          beforeStatePreparation: expect.any(Function),
        }),
      );
    });
  });

  it("drops gateway.env selectors when the default state dotenv selects a custom state", async () => {
    await withGatewayHome(
      (home) => ({
        ".openclaw/.env": `OPENCLAW_STATE_DIR=${path.join(home, "selected-state")}\n`,
        ".config/openclaw/gateway.env":
          "OPENCLAW_CONFIG_PATH=/tmp/wrong-openclaw.json\nOPENCLAW_GATEWAY_TOKEN=fallback-token\n",
        "selected-state/.env":
          "OPENCLAW_GATEWAY_TOKEN=selected-token\nOPENCLAW_INCLUDE_ROOTS=/tmp/untrusted-include-root\nNODE_OPTIONS=--require /tmp/untrusted.js\n",
      }),
      async (home) => {
        await f.runCli(f.cliArgs("gateway"));
        expectEnv({
          STATE_DIR: path.join(home, "selected-state"),
          CONFIG_PATH: undefined,
          GATEWAY_TOKEN: "selected-token",
        });
      },
    );
  });

  it("preserves gateway.env selectors when the compatibility fallback selects the target", async () => {
    await withGatewayHome(
      (home) => ({
        ".config/openclaw/gateway.env": `OPENCLAW_STATE_DIR=${path.join(home, "selected-state")}\nOPENCLAW_GATEWAY_TOKEN=fallback-token\n`,
        "selected-state/.env": "OPENCLAW_GATEWAY_TOKEN=selected-token\n",
      }),
      async (home) => {
        await f.runCli(f.cliArgs("gateway"));
        expectEnv({
          STATE_DIR: path.join(home, "selected-state"),
          GATEWAY_TOKEN: "selected-token",
          INCLUDE_ROOTS: undefined,
        });
        expect(process.env.NODE_OPTIONS).toBeUndefined();
      },
    );
  });

  it("drops early target credentials when a later guard selects another state", async () => {
    await withGatewayHome(
      () => ({
        ".openclaw/.env": "OPENCLAW_GATEWAY_TOKEN=early-token\n",
        "selected-state/.env": "OPENCLAW_GATEWAY_TOKEN=selected-token\n",
      }),
      async (home) => {
        const selectedStateDir = path.join(home, "selected-state");
        let selectLateState = false;
        selectConfig(
          () => selectLateState && process.env.OPENCLAW_STATE_DIR !== selectedStateDir,
          localConfig({ OPENCLAW_STATE_DIR: selectedStateDir }),
        );
        await f.runCli(f.cliArgs("gateway"));
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("early-token");
        selectLateState = true;
        await f.runGatewayBeforeHook();
        expectEnv({ STATE_DIR: selectedStateDir, GATEWAY_TOKEN: "selected-token" });
        expect(f.ensureCliExecutionBootstrapMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("drops normalized credentials from an early config replaced by a later guard", async () => {
    const { normalizeEnv, normalizeZaiEnv } = await import("../infra/env.js");
    await withEnvAsync({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, async () => {
      let useReplacement = false;
      f.readConfigFileSnapshotMock.mockImplementation(async () =>
        f.validConfig({
          env: { vars: { Z_AI_API_KEY: useReplacement ? "replacement-key" : "superseded-key" } },
          gateway: { mode: "local" },
        }),
      );
      await vi.mocked(normalizeEnv).withImplementation(
        () => normalizeZaiEnv(),
        async () => {
          await f.runCli(f.cliArgs("gateway"));
          expect(process.env.ZAI_API_KEY).toBe("superseded-key");

          useReplacement = true;
          await f.runGatewayBeforeHook();

          expect([process.env.Z_AI_API_KEY, process.env.ZAI_API_KEY]).toEqual([
            "replacement-key",
            "replacement-key",
          ]);
        },
      );
    });
  });

  it("does not let gateway.env authorize automatic mutations of a selected future config", async () => {
    await withGatewayHome(
      () => ({
        ".config/openclaw/gateway.env": "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1\n",
      }),
      async (home) => {
        const futureConfigPath = path.join(home, "future.json");
        selectConfig(
          () => process.env.OPENCLAW_CONFIG_PATH === futureConfigPath,
          futureConfig,
          localConfig({ OPENCLAW_CONFIG_PATH: futureConfigPath }),
        );
        await expectBlocked("run gateway state preparation");
        expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
      },
    );
  });

  it("retains selected config paths and invocation reset targets", async () => {
    const targets: Array<[string, string | undefined, string]> = [
      [
        "CONFIG_PATH",
        "/tmp/openclaw-invocation/openclaw.json",
        "/tmp/openclaw-reset/openclaw.json",
      ],
      ["GATEWAY_TOKEN", undefined, "old-token"],
      ["HOME", "/tmp/openclaw-invocation-home", "/tmp/openclaw-reset-home"],
      ["INCLUDE_ROOTS", undefined, "/tmp/openclaw-reset-includes"],
      ["PROFILE", undefined, "config-dev"],
      ["STATE_DIR", "/tmp/openclaw-invocation-state", "/tmp/openclaw-reset"],
      ["TEST_FAST", "1", "0"],
      ["WORKSPACE_DIR", "/tmp/openclaw-invocation-workspace", "/tmp/openclaw-reset-workspace"],
    ];
    const invocation = Object.fromEntries(targets.map(([key, value]) => [key, value]));
    await withEnvAsync(openClawEnv(invocation), async () => {
      primeConfig({
        env: {
          vars: Object.fromEntries(targets.map(([key, , value]) => [`OPENCLAW_${key}`, value])),
        },
        gateway: { mode: "local" },
      });
      await f.runCli(f.cliArgs("gateway", "--dev", "--reset"));
      await f.runGatewayBeforeHook({ reset: true });
      expectEnv(invocation);
      expect(f.ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
    });
  });

  it("honors banner suppression on the gateway foreground fast path", async () => {
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await f.runCli(f.cliArgs("gateway"));

    expect(f.tryRouteCliMock).not.toHaveBeenCalled();
    expect(f.emitCliBannerMock).not.toHaveBeenCalled();
    expect(f.commanderParseAsyncMock).toHaveBeenCalledWith(f.cliArgs("gateway"));
  });

  it("keeps explicit database preflight isolated from default state selection", async () => {
    f.tryRouteCliMock.mockResolvedValueOnce(true);

    await f.runCli(f.cliArgs("database", "preflight", "/tmp/openclaw-candidate.sqlite", "--json"));

    expect(f.loadDotEnvMock).not.toHaveBeenCalled();
    expect(f.loadConfigMock).not.toHaveBeenCalled();
    expect(f.startProxyMock).not.toHaveBeenCalled();
  });

  it("replaces the early managed proxy with the final accepted gateway config", async () => {
    f.existsSyncOverride.value = (target) => target === path.join(process.cwd(), ".env");
    const finalHandle = makeProxyHandle();
    const { early: earlyHandle, config: earlyProxy } = primeProxy(finalHandle);
    const finalProxy = { proxyUrl: "http://127.0.0.1:29876" };
    f.commanderParseAsyncMock.mockImplementationOnce(async () => {
      await f.runGatewayBeforeHook();
      await getGatewayRunRuntimeHooks().refreshManagedProxy?.(finalProxy);
    });

    await f.runCli(f.cliArgs("gateway", "run"));

    expect(f.loadDotEnvMock).toHaveBeenCalledWith({ loadGlobalEnv: false, quiet: true });
    expect(f.loadConfigMock).toHaveBeenCalledWith(f.readOnlyCoreOptions);
    expect(f.startProxyMock.mock.calls).toEqual([[earlyProxy], [finalProxy]]);
    expect(f.stopProxyMock.mock.calls).toEqual([[earlyHandle], [finalHandle]]);
    const earlyStopOrder = f.stopProxyMock.mock.invocationCallOrder[0] ?? 0;
    const finalEnvironmentReadOrder = f.readConfigFileSnapshotMock.mock.invocationCallOrder[1] ?? 0;
    const finalStartOrder = f.startProxyMock.mock.invocationCallOrder[1] ?? 0;
    expect(finalEnvironmentReadOrder).toBeGreaterThan(earlyStopOrder);
    expect(finalStartOrder).toBeGreaterThan(earlyStopOrder);
  });

  it("removes early proxy signal handlers when the final config disables the proxy", async () => {
    const { early: earlyHandle, config: earlyProxy } = primeProxy(null);
    const finalProxy = undefined;
    const processOnceSpy = vi.spyOn(process, "once");
    const processOffSpy = vi.spyOn(process, "off");
    f.commanderParseAsyncMock.mockImplementationOnce(async () => {
      const installed = ["SIGTERM", "SIGINT", "exit"].map((signal) => [
        signal,
        processOnceSpy.mock.calls.find(([event]) => event === signal)?.[1],
      ]);

      await getGatewayRunRuntimeHooks().refreshManagedProxy?.(finalProxy);

      for (const [signal, handler] of installed) {
        expect(processOffSpy).toHaveBeenCalledWith(signal, handler);
      }
    });

    try {
      await f.runCli(f.cliArgs("gateway", "run"));
    } finally {
      processOffSpy.mockRestore();
      processOnceSpy.mockRestore();
    }

    expect(f.startProxyMock).toHaveBeenNthCalledWith(1, earlyProxy);
    expect(f.startProxyMock).toHaveBeenNthCalledWith(2, finalProxy);
    expect(f.stopProxyMock).toHaveBeenCalledExactlyOnceWith(earlyHandle);
  });
});
