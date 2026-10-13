import "../test-utils/prepare-compiled-subprocesses.js";
// Register fixture mocks before modules that consume them.
// oxfmt-ignore
import {
  installRunMainTestHooks,
  cliArgs,
  readOnlyCoreOptions,
  tempDirs,
  runCli,
  tryRouteCliMock,
  loadDotEnvMock,
  existsSyncOverride,
  assertRuntimeMock,
  buildProgramMock,
  parkCurrentLaunchAgentForMaintenanceMock,
  readConfigFileSnapshotMock,
  commanderParseAsyncMock,
  addGatewayRunCommandMock,
  ensureCliExecutionBootstrapMock,
  emitCliBannerMock,
  loadConfigMock,
  startProxyMock,
  stopProxyMock,
  withCliExitSpies,
  runGatewayBeforeHook,
  makeProgram,
  validConfig,
} from "./run-main.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { createNewerSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getGatewayRunRuntimeHooks } from "./gateway-cli/runtime-hooks.js";
import { makeProxyHandle } from "./run-main.proxy-exit.test-support.js";

async function withGatewayHome(
  files: (home: string) => Record<string, string>,
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = tempDirs.make("openclaw-run-main-env-");
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
  installRunMainTestHooks();

  it.each(["environment selection", "full Commander preaction"])(
    "parks the managed Gateway when a newer schema blocks %s",
    async (phase) => {
      const error = createNewerSqliteSchemaVersionError(
        "OpenClaw state database",
        "/tmp/openclaw-startup/state/openclaw.sqlite",
        14,
        13,
      );
      const argv = cliArgs("--log-level", "debug", "gateway", "run");
      if (phase === "environment selection") {
        readConfigFileSnapshotMock.mockRejectedValueOnce(error);
      } else {
        buildProgramMock.mockReturnValueOnce(
          makeProgram("gateway", vi.fn().mockRejectedValueOnce(error)),
        );
        tryRouteCliMock.mockResolvedValueOnce(false);
      }
      await withCliExitSpies(async (errorSpy, exitSpy) => {
        await expect(runCli(argv)).rejects.toMatchObject({ name: "ExitError", code: 78 });

        expect(parkCurrentLaunchAgentForMaintenanceMock).toHaveBeenCalledOnce();
        expect(exitSpy).toHaveBeenCalledWith(78);
        expect(errorSpy.mock.calls.flat().join("\n")).toContain(error.message);
        expect(addGatewayRunCommandMock).not.toHaveBeenCalled();
        if (phase === "environment selection") {
          expect(buildProgramMock).not.toHaveBeenCalled();
        } else {
          expect(buildProgramMock).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it.each([
    { label: "Gateway help", args: ["gateway", "--help"] },
    { label: "another command", args: ["status"] },
  ])("does not park the Gateway for a newer-schema failure during $label", async ({ args }) => {
    const error = createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      "/tmp/openclaw-startup/state/openclaw.sqlite",
      14,
      13,
    );
    buildProgramMock.mockReturnValueOnce(
      makeProgram(args[0], vi.fn().mockRejectedValueOnce(error)),
    );

    await withEnvAsync({ OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1" }, async () => {
      await expect(runCli(cliArgs(...args))).rejects.toBe(error);
    });

    expect(parkCurrentLaunchAgentForMaintenanceMock).not.toHaveBeenCalled();
  });

  it("defers config-drift exit until readiness releases its lease", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig(
        {
          cron: { store: "/tmp/included-a.json" },
          gateway: { mode: "local" },
        },
        { hash: "guarded", path: "/tmp/openclaw.json", raw: "{}" },
      ),
    );
    await runCli(cliArgs("gateway"));
    await runGatewayBeforeHook();
    const beforeStatePreparation =
      ensureCliExecutionBootstrapMock.mock.calls[0]?.[0]?.beforeStatePreparation;
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig(
        {
          cron: { store: "/tmp/included-b.json" },
          gateway: { mode: "local" },
        },
        { hash: "guarded", path: "/tmp/openclaw.json", raw: "{}" },
      ),
    );
    await withCliExitSpies(async (errorSpy, exitSpy) => {
      await expect(beforeStatePreparation?.()).rejects.toMatchObject({
        name: "ExitError",
        code: 1,
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("changed during startup"));
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  it("defers a service-mode future-config exit to readiness", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig(
        { gateway: { mode: "local" } },
        { hash: "guarded", path: "/tmp/openclaw.json", raw: "{}" },
      ),
    );
    await runCli(cliArgs("gateway"));
    await runGatewayBeforeHook();
    const beforeStatePreparation =
      ensureCliExecutionBootstrapMock.mock.calls[0]?.[0]?.beforeStatePreparation;
    await withCliExitSpies(async (errorSpy, exitSpy) => {
      await withEnvAsync(
        {
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
          OPENCLAW_SERVICE_MARKER: undefined,
        },
        async () => {
          await expect(
            beforeStatePreparation?.(
              validConfig(
                {
                  env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } },
                  meta: { lastTouchedVersion: "9999.1.1" },
                },
                { hash: "future", path: "/tmp/openclaw.json", raw: "{}" },
              ),
            ),
          ).rejects.toMatchObject({ name: "ExitError", code: 78 });
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("start the gateway service"),
          );
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
          expect(exitSpy).not.toHaveBeenCalled();
        },
      );
    });
  });

  it.each([
    { flags: [], service: true, action: "start the gateway service", code: 78 },
    { flags: ["--force"], service: false, action: "force-kill gateway port listeners", code: 1 },
    { flags: ["--dev", "--reset"], service: false, action: "reset the dev gateway state", code: 1 },
  ])("blocks future config before $action", async ({ flags, service, action, code }) => {
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig({ meta: { lastTouchedVersion: "9999.1.1" } }),
    );
    await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: service ? "gateway" : undefined,
        OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: service ? "1" : undefined,
      },
      () =>
        withCliExitSpies(async (errorSpy) => {
          await expect(runCli(cliArgs("gateway", ...flags))).rejects.toMatchObject({
            name: "ExitError",
            code,
          });
          expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(action));
          expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
          expect(readConfigFileSnapshotMock.mock.calls).toEqual([[readOnlyCoreOptions]]);
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        }),
    );
  });

  it("blocks and revokes the destructive override when selected config declares service mode", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      validConfig({
        env: { vars: { OPENCLAW_SERVICE_MARKER: "gateway" } },
        meta: { lastTouchedVersion: "9999.1.1" },
      }),
    );
    await withCliExitSpies(async () => {
      await withEnvAsync(
        {
          OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
          OPENCLAW_SERVICE_MARKER: undefined,
        },
        async () => {
          await expect(runCli(cliArgs("gateway"))).rejects.toMatchObject({
            name: "ExitError",
            code: 78,
          });
          expect(process.env.OPENCLAW_SERVICE_MARKER).toBeUndefined();
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
          expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
        },
      );
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
        await runCli(cliArgs("gateway"));
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("state-token");
        expect(process.env.OPENCLAW_GATEWAY_PASSWORD).toBe("config-root-password");
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
        readConfigFileSnapshotMock.mockImplementation(async () =>
          validConfig(
            process.env.OPENCLAW_CONFIG_PATH === path.join(stateDir, "future.json")
              ? { meta: { lastTouchedVersion: "9999.1.1" } }
              : { env: { vars: { OPENCLAW_STATE_DIR: stateDir } }, gateway: { mode: "local" } },
          ),
        );
        await withCliExitSpies(async (errorSpy) => {
          await expect(runCli(cliArgs("gateway"))).rejects.toMatchObject({
            name: "ExitError",
            code: 1,
          });
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("run gateway state preparation"),
          );
          expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
          expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(2);
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        });
      },
    );
  });

  it("does not apply environment variables from invalid config snapshots", async () => {
    await withEnvAsync({ OPENCLAW_INCLUDE_ROOTS: undefined }, async () => {
      readConfigFileSnapshotMock.mockResolvedValue({
        exists: true,
        issues: [{ message: "invalid", path: "gateway" }],
        legacyIssues: [],
        valid: false,
        sourceConfig: {
          env: { vars: { OPENCLAW_INCLUDE_ROOTS: "/tmp/openclaw-includes" } },
          gateway: { mode: "local" },
        },
      });

      await runCli(cliArgs("gateway"));
      await runGatewayBeforeHook();

      expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
      expect(readConfigFileSnapshotMock.mock.calls).toEqual([
        [readOnlyCoreOptions],
        [readOnlyCoreOptions],
      ]);
      expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledWith(
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
        await runCli(cliArgs("gateway"));
        expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(home, "selected-state"));
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
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
        await runCli(cliArgs("gateway"));
        expect(process.env.OPENCLAW_STATE_DIR).toBe(path.join(home, "selected-state"));
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
        expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
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
        readConfigFileSnapshotMock.mockImplementation(async () =>
          validConfig(
            selectLateState && process.env.OPENCLAW_STATE_DIR !== selectedStateDir
              ? {
                  env: { vars: { OPENCLAW_STATE_DIR: selectedStateDir } },
                  gateway: { mode: "local" },
                }
              : { gateway: { mode: "local" } },
          ),
        );
        await runCli(cliArgs("gateway"));
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("early-token");
        selectLateState = true;
        await runGatewayBeforeHook();
        expect(process.env.OPENCLAW_STATE_DIR).toBe(selectedStateDir);
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("selected-token");
        expect(ensureCliExecutionBootstrapMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("drops normalized credentials from an early config replaced by a later guard", async () => {
    const { normalizeEnv, normalizeZaiEnv } = await import("../infra/env.js");
    await withEnvAsync({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, async () => {
      let useReplacement = false;
      readConfigFileSnapshotMock.mockImplementation(async () =>
        validConfig({
          env: { vars: { Z_AI_API_KEY: useReplacement ? "replacement-key" : "superseded-key" } },
          gateway: { mode: "local" },
        }),
      );
      await vi.mocked(normalizeEnv).withImplementation(
        () => normalizeZaiEnv(),
        async () => {
          await runCli(cliArgs("gateway"));
          expect(process.env.ZAI_API_KEY).toBe("superseded-key");

          useReplacement = true;
          await runGatewayBeforeHook();

          expect(process.env.Z_AI_API_KEY).toBe("replacement-key");
          expect(process.env.ZAI_API_KEY).toBe("replacement-key");
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
        readConfigFileSnapshotMock.mockImplementation(async () =>
          validConfig(
            process.env.OPENCLAW_CONFIG_PATH === futureConfigPath
              ? { meta: { lastTouchedVersion: "9999.1.1" } }
              : {
                  env: { vars: { OPENCLAW_CONFIG_PATH: futureConfigPath } },
                  gateway: { mode: "local" },
                },
          ),
        );
        await withCliExitSpies(async (errorSpy) => {
          await expect(runCli(cliArgs("gateway"))).rejects.toMatchObject({
            name: "ExitError",
            code: 1,
          });
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("run gateway state preparation"),
          );
          expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
          expect(process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS).toBeUndefined();
        });
      },
    );
  });

  it("retains selected config paths and invocation reset targets", async () => {
    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-invocation/openclaw.json",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_HOME: "/tmp/openclaw-invocation-home",
        OPENCLAW_INCLUDE_ROOTS: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: "/tmp/openclaw-invocation-state",
        OPENCLAW_TEST_FAST: "1",
        OPENCLAW_WORKSPACE_DIR: "/tmp/openclaw-invocation-workspace",
      },
      async () => {
        readConfigFileSnapshotMock.mockResolvedValue(
          validConfig({
            env: {
              vars: {
                OPENCLAW_CONFIG_PATH: "/tmp/openclaw-reset/openclaw.json",
                OPENCLAW_GATEWAY_TOKEN: "old-token",
                OPENCLAW_HOME: "/tmp/openclaw-reset-home",
                OPENCLAW_INCLUDE_ROOTS: "/tmp/openclaw-reset-includes",
                OPENCLAW_PROFILE: "config-dev",
                OPENCLAW_STATE_DIR: "/tmp/openclaw-reset",
                OPENCLAW_TEST_FAST: "0",
                OPENCLAW_WORKSPACE_DIR: "/tmp/openclaw-reset-workspace",
              },
            },
            gateway: { mode: "local" },
          }),
        );
        await runCli(cliArgs("gateway", "--dev", "--reset"));

        await runGatewayBeforeHook({ reset: true });

        expect(process.env.OPENCLAW_CONFIG_PATH).toBe("/tmp/openclaw-invocation/openclaw.json");
        expect(process.env.OPENCLAW_HOME).toBe("/tmp/openclaw-invocation-home");
        expect(process.env.OPENCLAW_PROFILE).toBeUndefined();
        expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-invocation-state");
        expect(process.env.OPENCLAW_TEST_FAST).toBe("1");
        expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe("/tmp/openclaw-invocation-workspace");
        expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
        expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
        expect(ensureCliExecutionBootstrapMock).not.toHaveBeenCalled();
      },
    );
  });

  it("honors banner suppression on the gateway foreground fast path", async () => {
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await runCli(cliArgs("gateway"));

    expect(tryRouteCliMock).not.toHaveBeenCalled();
    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(commanderParseAsyncMock).toHaveBeenCalledWith(cliArgs("gateway"));
  });

  it.each([
    ["full Commander path with root options", cliArgs("--log-level", "debug", "gateway", "run")],
  ])("isolates %s gateway proxy config reads core-only", async (_name, argv) => {
    existsSyncOverride.value = (target) => target === path.join(process.cwd(), ".env");
    if (_name === "full Commander path with root options") {
      tryRouteCliMock.mockResolvedValueOnce(false);
      buildProgramMock.mockReturnValueOnce(makeProgram("gateway", commanderParseAsyncMock));
    }
    await runCli(argv);

    expect(loadDotEnvMock).toHaveBeenCalledWith({ loadGlobalEnv: false, quiet: true });
    if (_name === "full Commander path with root options") {
      expect(buildProgramMock).toHaveBeenCalledTimes(1);
      expect(commanderParseAsyncMock).toHaveBeenLastCalledWith(argv);
    }
    expect(loadConfigMock).toHaveBeenCalledWith(readOnlyCoreOptions);
    expect(startProxyMock).toHaveBeenCalledWith(undefined);
  });

  it("keeps explicit database preflight isolated from default state selection", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);

    await runCli(cliArgs("database", "preflight", "/tmp/openclaw-candidate.sqlite", "--json"));

    expect(loadDotEnvMock).not.toHaveBeenCalled();
    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(startProxyMock).not.toHaveBeenCalled();
  });

  it("stops before config selection when asynchronous runtime validation rejects", async () => {
    const error = new Error("unsupported runtime");
    const validation = Promise.reject(error);
    // The regression must also join this rejection when old code ignores the returned promise.
    void validation.catch(() => {});
    assertRuntimeMock.mockReturnValueOnce(validation);

    await expect(runCli(cliArgs("gateway", "run"))).rejects.toBe(error);
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("replaces the early managed proxy with the final accepted gateway config", async () => {
    const earlyHandle = makeProxyHandle();
    const finalHandle = makeProxyHandle();
    const earlyProxy = { proxyUrl: "http://127.0.0.1:19876" };
    const finalProxy = { proxyUrl: "http://127.0.0.1:29876" };
    loadConfigMock.mockReturnValueOnce({ proxy: earlyProxy });
    startProxyMock.mockResolvedValueOnce(earlyHandle).mockResolvedValueOnce(finalHandle);
    commanderParseAsyncMock.mockImplementationOnce(async () => {
      await runGatewayBeforeHook();
      await getGatewayRunRuntimeHooks().refreshManagedProxy?.(finalProxy);
    });

    await runCli(cliArgs("gateway", "run"));

    expect(startProxyMock).toHaveBeenNthCalledWith(1, earlyProxy);
    expect(startProxyMock).toHaveBeenNthCalledWith(2, finalProxy);
    expect(stopProxyMock).toHaveBeenNthCalledWith(1, earlyHandle);
    expect(stopProxyMock).toHaveBeenNthCalledWith(2, finalHandle);
    const earlyStopOrder = stopProxyMock.mock.invocationCallOrder[0] ?? 0;
    const finalEnvironmentReadOrder = readConfigFileSnapshotMock.mock.invocationCallOrder[1] ?? 0;
    const finalStartOrder = startProxyMock.mock.invocationCallOrder[1] ?? 0;
    expect(finalEnvironmentReadOrder).toBeGreaterThan(earlyStopOrder);
    expect(finalStartOrder).toBeGreaterThan(earlyStopOrder);
  });

  it("removes early proxy signal handlers when the final config disables the proxy", async () => {
    const earlyHandle = makeProxyHandle();
    const earlyProxy = { proxyUrl: "http://127.0.0.1:19876" };
    const finalProxy = undefined;
    loadConfigMock.mockReturnValueOnce({ proxy: earlyProxy });
    startProxyMock.mockResolvedValueOnce(earlyHandle).mockResolvedValueOnce(null);
    const processOnceSpy = vi.spyOn(process, "once");
    const processOffSpy = vi.spyOn(process, "off");
    commanderParseAsyncMock.mockImplementationOnce(async () => {
      const sigtermHandler = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      const sigintHandler = processOnceSpy.mock.calls.find(([event]) => event === "SIGINT")?.[1];
      const exitHandler = processOnceSpy.mock.calls.find(([event]) => event === "exit")?.[1];

      await getGatewayRunRuntimeHooks().refreshManagedProxy?.(finalProxy);

      expect(processOffSpy).toHaveBeenCalledWith("SIGTERM", sigtermHandler);
      expect(processOffSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
      expect(processOffSpy).toHaveBeenCalledWith("exit", exitHandler);
    });

    try {
      await runCli(cliArgs("gateway", "run"));
    } finally {
      processOffSpy.mockRestore();
      processOnceSpy.mockRestore();
    }

    expect(startProxyMock).toHaveBeenNthCalledWith(1, earlyProxy);
    expect(startProxyMock).toHaveBeenNthCalledWith(2, finalProxy);
    expect(stopProxyMock).toHaveBeenCalledOnce();
    expect(stopProxyMock).toHaveBeenCalledWith(earlyHandle);
  });
});
