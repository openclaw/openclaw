import { PassThrough } from "node:stream";
/** Tests node-host runner startup, connection configuration, and lifecycle. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGatewayConnectAuth,
  selectGatewayConnectAuth,
} from "../../packages/gateway-client/src/connect-auth.js";
import type { EventLoopReadyResult } from "../../packages/gateway-client/src/event-loop-ready.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as oneShotExit from "../cli/one-shot-exit.js";
import { getConfigResolutionFacts, setConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  getExistingOpenClawStateSchemaPath,
  withExistingOpenClawStateSchema,
} from "../state/openclaw-state-db-schema-policy.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  lastCapturedOptions,
  loadResumableNodeHostGateway,
  mocks,
  resetRunnerTestState,
  runNodeHost,
  startNodeHostMcpManager,
} from "./runner.test-support.js";

const localGateway = { gatewayHost: "127.0.0.1", gatewayPort: 18789 };

async function expectStartupTimeout(options: Partial<Parameters<typeof runNodeHost>[0]> = {}) {
  await expect(runNodeHost({ ...localGateway, ...options })).rejects.toThrow(
    "event loop readiness timeout",
  );
}

function readyNodeHost() {
  mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
    ready: true,
    aborted: false,
    elapsedMs: 0,
    maxDriftMs: 0,
    checks: 1,
  });
}

async function withReadyNodeHost(
  runTest: () => Promise<void>,
  options: Partial<Parameters<typeof runNodeHost>[0]> = {},
) {
  readyNodeHost();
  const on = vi.spyOn(process, "on");
  const previousExitCode = process.exitCode;
  const running = runNodeHost({ ...localGateway, ...options });
  try {
    await vi.waitFor(() => expect(on).toHaveBeenCalledWith("SIGTERM", expect.any(Function)));
    await runTest();
  } finally {
    on.mock.calls.find(([event]) => event === "SIGTERM")?.[1]?.("SIGTERM");
    await running;
    process.exitCode = previousExitCode;
    on.mockRestore();
  }
}

describe("runNodeHost", () => {
  beforeEach(resetRunnerTestState);

  it("retains managed state admission while an external signal closes the runtime", async () => {
    mocks.useFakeRuntime = true;
    readyNodeHost();
    const statePath = resolveOpenClawStateSqlitePath();
    let cleanupStatePath: string | undefined;
    mocks.activeRuntime.close.mockImplementationOnce(async () => {
      cleanupStatePath = getExistingOpenClawStateSchemaPath();
    });
    const on = vi.spyOn(process, "on");
    const previousExitCode = process.exitCode;
    const running = withExistingOpenClawStateSchema({ path: statePath }, () =>
      runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 }),
    );
    const stop = () => on.mock.calls.find(([event]) => event === "SIGTERM")?.[1]?.("SIGTERM");
    try {
      await vi.waitFor(() => expect(on).toHaveBeenCalledWith("SIGTERM", expect.any(Function)));
      expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
      stop();
      await running;
      expect(cleanupStatePath).toBe(statePath);
      expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
      expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
    } finally {
      stop();
      await running;
      process.exitCode = previousExitCode;
      on.mockRestore();
    }
  });

  it("joins the source node runtime when its companion stdin closes", async () => {
    mocks.useFakeRuntime = true;
    readyNodeHost();
    const input = new PassThrough();
    const previous = Object.getOwnPropertyDescriptor(process, "stdin");
    const previousExit = process.exitCode;
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    const running = runNodeHost({
      gatewayHost: "127.0.0.1",
      gatewayPort: 18789,
      parentStdin: true,
    });
    try {
      await vi.waitFor(() => expect(input.listenerCount("end")).toBe(1));
      input.end();
      await running;
      expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
      expect(mocks.capturedGatewayClients[0]?.stopAndWait).toHaveBeenCalledOnce();
      expect(input.listenerCount("end")).toBe(0);
    } finally {
      input.end();
      await running;
      if (previous) {
        Object.defineProperty(process, "stdin", previous);
      }
      process.exitCode = previousExit;
    }
  });

  it("persists the pairing candidate that completes the handshake", async () => {
    mocks.useFakeRuntime = true;
    await withReadyNodeHost(
      async () => {
        const firstOptions = mocks.capturedGatewayClientOptions[0];
        firstOptions?.onClose?.(1006, "transport unavailable", {
          phase: "pre-hello",
          socketOpened: false,
          transportValidated: false,
          connectRequestSent: false,
          transientPreHelloCleanClose: false,
        });
        await vi.waitFor(() => expect(mocks.capturedGatewayClients).toHaveLength(2));

        expect(mocks.capturedGatewayClientOptions[1]?.url).toBe(
          "wss://gateway.tailnet.example:443",
        );

        mocks.capturedGatewayClientOptions[1]?.onHelloOk?.({} as never);
        await vi.waitFor(() => expect(mocks.configureNodeHost).toHaveBeenCalledTimes(2));
        expect(mocks.capturedConfiguredGatewayConfigs[1]).toEqual({
          host: "gateway.tailnet.example",
          port: 443,
          tls: true,
        });
      },
      {
        gatewayHost: "192.168.1.20",
        gatewayPort: 18789,
        gatewayBootstrapToken: "bootstrap-123",
        preferGatewayBootstrapToken: true,
        gatewayCandidates: [
          { host: "192.168.1.20", port: 18789, tls: false },
          { host: "gateway.tailnet.example", port: 443, tls: true },
        ],
      },
    );
  });

  it("routes invoke input, cancellation, and connection close to the runtime", async () => {
    mocks.useFakeRuntime = true;
    await withReadyNodeHost(async () => {
      const options = lastCapturedOptions();
      options?.onEvent?.({
        type: "event",
        event: "node.invoke.input",
        payload: { id: "invoke-1", nodeId: "node-1", seq: 3, payloadJSON: '{"kind":"data"}' },
      });
      options?.onEvent?.({
        type: "event",
        event: "node.invoke.cancel",
        payload: { invokeId: "invoke-1", nodeId: "node-1" },
      });
      options?.onClose?.(1000, "connection closed");

      expect(mocks.activeRuntime.handleInput).toHaveBeenCalledWith(
        "invoke-1",
        3,
        '{"kind":"data"}',
      );
      expect(mocks.activeRuntime.cancel).toHaveBeenCalledWith("invoke-1");
      expect(mocks.activeRuntime.cancelAll).toHaveBeenCalledOnce();
    });
  });

  it("strips remote credentials before resolving local node-host auth", async () => {
    const config = {
      gateway: {
        mode: "local",
        remote: { token: "remote-token", password: "remote-password" },
      },
    };
    setConfigResolutionFacts(
      config,
      new Set(["gateway.auth.token", "gateway.remote.token", "gateway.remote.password"]),
    );
    mocks.getRuntimeConfig.mockReturnValue(config);

    await expectStartupTimeout();

    const resolvedConfig =
      mocks.resolveGatewayCredentialsWithSecretInputs.mock.calls[0]?.[0].config;
    expect(resolvedConfig).toEqual({
      gateway: { mode: "local", remote: { token: undefined, password: undefined } },
    });
    expect(getConfigResolutionFacts(resolvedConfig)).toEqual(new Set(["gateway.auth.token"]));
    expect(config.gateway.remote).toEqual({
      token: "remote-token",
      password: "remote-password",
    });
  });

  it("does not inherit credentials from another Gateway for a companion", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: {
        mode: "remote",
        remote: { token: "other-gateway-token", password: "other-gateway-password" },
      },
    });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
    try {
      await expectStartupTimeout({
        gatewayHost: "selected.example",
        gatewayPort: 443,
        gatewayTls: true,
        gatewayAuthFromEnv: true,
      });
      expect(lastCapturedOptions()?.token).toBeUndefined();
      expect(lastCapturedOptions()?.password).toBeUndefined();
      expect(mocks.resolveGatewayCredentialsWithSecretInputs).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("saved node gateway authentication", () => {
    const gateway = { host: "paired.example", port: 443, tls: true, contextPath: "/node" };
    const runOptions = {
      gatewayHost: gateway.host,
      gatewayPort: gateway.port,
      gatewayTls: gateway.tls,
      gatewayContextPath: gateway.contextPath,
    };

    beforeEach(() => {
      mocks.useFakeRuntime = true;
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
      mocks.loadNodeHostConfig.mockResolvedValue({ version: 1, nodeId: "node-test", gateway });
      mocks.loadDeviceAuthTokenReadOnly.mockImplementation(async ({ role }) =>
        role === "node" ? { role, token: "paired-node-token", scopes: [], updatedAtMs: 1 } : null,
      );
      mocks.getRuntimeConfig.mockReturnValue({
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "SOURCE_GATEWAY_PASSWORD" },
          },
        },
      });
      mocks.resolveGatewayCredentialsWithSecretInputs.mockResolvedValue({
        password: "source-gateway-password",
      });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      mocks.resolveGatewayCredentialsWithSecretInputs.mockResolvedValue({});
    });

    it("offers the saved endpoint for resume only with a paired node credential", async () => {
      mocks.loadDeviceIdentityIfPresent.mockReturnValue({
        deviceId: "device-test",
        publicKeyPem: "public-key-test",
        privateKeyPem: "private-key-test",
      });
      await expect(loadResumableNodeHostGateway()).resolves.toEqual(gateway);

      // A failed first enrollment saves the endpoint without issuing a device token.
      mocks.loadDeviceAuthTokenReadOnly.mockResolvedValue(null);
      await expect(loadResumableNodeHostGateway()).resolves.toBeUndefined();
      expect(mocks.configureNodeHost).not.toHaveBeenCalled();
    });

    describe("expired fallback setup codes", () => {
      const expiredOptions = {
        ...runOptions,
        gatewayBootstrapToken: "expired-test-bootstrap",
        gatewayBootstrapExpiresAtMs: 1,
        preferGatewayBootstrapToken: false,
      };

      beforeEach(() => {
        mocks.loadDeviceIdentityIfPresent.mockReturnValue({
          deviceId: "device-test",
          publicKeyPem: "public-key-test",
          privateKeyPem: "private-key-test",
        });
      });

      it("never falls back to shared auth if the saved token disappears before connect", async () => {
        mocks.loadDeviceAuthTokenReadOnly
          .mockResolvedValueOnce({
            role: "node",
            token: "paired-node-token",
            scopes: [],
            updatedAtMs: 1,
          })
          .mockResolvedValue(null);
        vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "shared-test-token");

        await expectStartupTimeout(expiredOptions);

        expect(
          buildGatewayConnectAuth(
            selectGatewayConnectAuth({
              ...lastCapturedOptions(),
              storedToken: "paired-node-token",
            }),
          ),
        ).toMatchObject({ deviceToken: "paired-node-token", bootstrapToken: undefined });
        // GatewayClient rereads native auth when connecting; the token can be gone by then.
        const stored = await mocks.loadDeviceAuthTokenReadOnly({
          deviceId: "device-test",
          role: "node",
        });
        const options = lastCapturedOptions();
        expect(options?.bootstrapToken).toBeUndefined();
        const auth = buildGatewayConnectAuth(
          selectGatewayConnectAuth({ ...options, storedToken: stored?.token }),
        );
        expect(auth).toBeUndefined();
        expect(mocks.resolveGatewayCredentialsWithSecretInputs).not.toHaveBeenCalled();
      });

      it.each<[string, () => unknown, Partial<Parameters<typeof runNodeHost>[0]>]>([
        ["missing identity", () => mocks.loadDeviceIdentityIfPresent.mockReturnValue(null), {}],
        ["missing token", () => mocks.loadDeviceAuthTokenReadOnly.mockResolvedValue(null), {}],
        ["missing gateway", () => mocks.loadNodeHostConfig.mockResolvedValue(null), {}],
        [
          "mixed gateway scopes",
          () => {},
          {
            gatewayCandidates: [gateway, { ...gateway, contextPath: "/other-node" }],
          },
        ],
        ["forced pairing", () => {}, { preferGatewayBootstrapToken: true }],
      ])(
        "rejects expired pairing with %s before changing state",
        async (_label, prepare, overrides) => {
          prepare();
          await expect(runNodeHost({ ...expiredOptions, ...overrides })).rejects.toThrow(
            "Pairing setup code has expired.",
          );
          expect(mocks.configureNodeHost).not.toHaveBeenCalled();
          expect(mocks.capturedGatewayClients).toHaveLength(0);
        },
      );
    });

    it("restarts a paired service without sending the source Gateway password", async () => {
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "  ");
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "\t");
      await expectStartupTimeout(runOptions);

      const auth = buildGatewayConnectAuth(
        selectGatewayConnectAuth({ ...lastCapturedOptions(), storedToken: "paired-node-token" }),
      );
      expect(auth).toMatchObject({
        deviceToken: "paired-node-token",
        token: undefined,
        password: undefined,
      });
      expect(mocks.resolveGatewayCredentialsWithSecretInputs).not.toHaveBeenCalled();
      expect(lastCapturedOptions()?.deviceToken).toBeUndefined();
    });

    it("keeps remote-mode credentials when selecting another Gateway", async () => {
      mocks.getRuntimeConfig.mockReturnValue({
        gateway: {
          mode: "remote",
          remote: { url: "wss://another.example:443", token: "remote-token" },
        },
      });
      mocks.resolveGatewayCredentialsWithSecretInputs.mockResolvedValue({ token: "remote-token" });

      await expectStartupTimeout({ ...runOptions, gatewayHost: "another.example" });

      expect(lastCapturedOptions()?.token).toBe("remote-token");
      expect(mocks.resolveGatewayCredentialsWithSecretInputs).toHaveBeenCalledOnce();
    });
  });

  it("keeps a ref'd lifetime handle until a ready foreground host stops", async () => {
    readyNodeHost();
    const unref = vi.fn();
    const interval = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(global, "clearInterval").mockImplementation(() => {});
    const processOnSpy = vi.spyOn(process, "on");
    const previousExitCode = process.exitCode;
    const mcpClose = createDeferred<undefined>();
    mocks.closeMcpManager.mockReturnValueOnce(mcpClose.promise);
    try {
      const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
      await vi.waitFor(() =>
        expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function)),
      );
      await vi.waitFor(() => expect(startNodeHostMcpManager).toHaveBeenCalled());

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(unref).not.toHaveBeenCalled();
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      const onSigterm = processOnSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      expect(onSigterm).toBeTypeOf("function");
      onSigterm?.("SIGTERM");
      await vi.waitFor(() =>
        expect(mocks.capturedGatewayClients[0]?.stopAndWait).toHaveBeenCalledOnce(),
      );

      expect(clearIntervalSpy).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mocks.closeMcpManager).toHaveBeenCalledOnce());
      mcpClose.resolve(undefined);
      await running;

      expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    } finally {
      for (const [event, listener] of processOnSpy.mock.calls) {
        if ((event === "SIGINT" || event === "SIGTERM") && typeof listener === "function") {
          process.off(event, listener);
        }
      }
      process.exitCode = previousExitCode;
      processOnSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("closes MCP clients before exiting on a terminal reconnect pause", async () => {
    const readiness = createDeferred<EventLoopReadyResult>();
    const mcpClose = createDeferred<undefined>();
    mocks.startGatewayClientWhenEventLoopReady.mockReturnValueOnce(readiness.promise);
    mocks.closeMcpManager.mockReturnValueOnce(mcpClose.promise);
    const exit = vi.spyOn(oneShotExit, "requestExitAfterOneShotOutput").mockReturnValue(true);
    const previousExitCode = process.exitCode;
    const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
    const stopped = expect(running).resolves.toBeUndefined();
    try {
      await vi.waitFor(() => expect(startNodeHostMcpManager).toHaveBeenCalled());
      lastCapturedOptions()?.onReconnectPaused?.({
        code: 1008,
        reason: "connect failed",
        detailCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
      });
      await vi.waitFor(() => {
        expect(mocks.closeMcpManager).toHaveBeenCalledOnce();
      });
      expect(mocks.capturedGatewayClients[0]?.stopAndWait).toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      mcpClose.resolve(undefined);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(undefined, 1));

      readiness.resolve({ ready: false, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 0 });
      await stopped;
      expect(process.exitCode).toBe(1);
      expect(mocks.closeMcpManager).toHaveBeenCalledOnce();
      expect(mocks.capturedGatewayClients[0]?.stopAndWait).toHaveBeenCalledOnce();
    } finally {
      mcpClose.resolve(undefined);
      readiness.resolve({ ready: false, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 0 });
      try {
        // Shutdown owns the exit callback; keep it intercepted until the run settles.
        await stopped;
      } finally {
        process.exitCode = previousExitCode;
        exit.mockRestore();
      }
    }
  });

  it("keeps pairing reconnect pauses visible without stopping the foreground host", async () => {
    await expectStartupTimeout();
    mocks.closeMcpManager.mockClear();
    mocks.capturedGatewayClients[0]?.stopAndWait.mockClear();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      lastCapturedOptions()?.onReconnectPaused?.({
        code: 1008,
        reason: "connect failed",
        detailCode: ConnectErrorDetailCodes.PAIRING_REQUIRED,
      });

      expect(stderr).toHaveBeenCalledWith(
        "node host gateway reconnect paused after close (1008): connect failed detail=PAIRING_REQUIRED; waiting for operator action\n",
      );
      expect(mocks.closeMcpManager).not.toHaveBeenCalled();
      expect(mocks.capturedGatewayClients[0]?.stopAndWait).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
    }
  });

  it.each([
    ["::1", "gws", "ws://[::1]:18789/gws"],
    ["[::1]", "/gws/", "ws://[::1]:18789/gws/"],
  ])("formats Gateway endpoint %s%s", async (gatewayHost, gatewayContextPath, expectedUrl) => {
    await expectStartupTimeout({ gatewayHost, gatewayContextPath });
    expect(lastCapturedOptions()?.url).toBe(expectedUrl);
    expect(mocks.capturedConfiguredGatewayConfigs.at(-1)?.contextPath).toBe(gatewayContextPath);
  });
});
