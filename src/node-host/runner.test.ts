import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGatewayConnectAuth,
  selectGatewayConnectAuth,
} from "../../packages/gateway-client/src/connect-auth.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as oneShotExit from "../cli/one-shot-exit.js";
import { getConfigResolutionFacts, setConfigResolutionFacts } from "../config/resolution-facts.js";
import { GatewayClientRequestError, type GatewayClientOptions } from "../gateway/client.js";
import { NODE_RUNNER_INVENTORY_UPDATE_METHOD } from "../infra/node-runner-inventory.js";
import {
  getExistingOpenClawStateSchemaPath,
  withExistingOpenClawStateSchema,
} from "../state/openclaw-state-db-schema-policy.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  expectCalls,
  expectStartupTimeout,
  lastCapturedOptions,
  loadResumableNodeHostGateway,
  mocks,
  receiveHello,
  resetRunnerTestState,
  runNodeHost,
  startNodeHostMcpManager,
  withReadyNodeHost,
} from "./runner.test-support.js";

const deviceIdentity = {
  deviceId: "device-test",
  publicKeyPem: "public-key-test",
  privateKeyPem: "private-key-test",
};
const pairedToken = { role: "node", token: "paired-node-token", scopes: [], updatedAtMs: 1 };
const connectAuth = (storedToken: string | undefined = "paired-node-token") =>
  buildGatewayConnectAuth(selectGatewayConnectAuth({ ...lastCapturedOptions(), storedToken }));
const remoteConfig = (
  remote: { token: string; password?: string; url?: string },
  mode: "remote" | "local" = "remote",
) => ({
  gateway: { mode, remote },
});
const upgradeError = (details: Record<string, unknown>) =>
  new GatewayClientRequestError({
    code: "UNAVAILABLE",
    details: { reason: "websocket-upgrade-rejected", ...details },
  });

const NODE_PLUGIN_TOOLS_UPDATE_METHOD = "node.pluginTools.update";
const NODE_SKILLS_UPDATE_METHOD = "node.skills.update";
const optionalMethods = [
  NODE_PLUGIN_TOOLS_UPDATE_METHOD,
  NODE_SKILLS_UPDATE_METHOD,
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
];
type CapturedClient = (typeof mocks.capturedGatewayClients)[number];

function getPublications(client: CapturedClient, method = NODE_PLUGIN_TOOLS_UPDATE_METHOD) {
  return client.request.mock.calls.filter(([calledMethod]) => calledMethod === method);
}

const settlePublications = () => setImmediate();

const expectPublications = (client: CapturedClient, count: number) =>
  vi.waitFor(() => expect(getPublications(client)).toHaveLength(count));

function changeTools(tools: typeof mocks.nodePluginTools) {
  mocks.nodePluginTools = tools;
  mocks.availabilityChanged?.();
}

async function beginPublication(
  client: CapturedClient,
  options: GatewayClientOptions,
  ...responses: Promise<unknown>[]
) {
  queuePluginResponses(client, ...responses);
  receiveHello(options);
  await expectPublications(client, 1);
}

function queuePluginResponses(client: CapturedClient, ...responses: Promise<unknown>[]) {
  client.request.mockImplementation((method) =>
    method === NODE_PLUGIN_TOOLS_UPDATE_METHOD
      ? (responses.shift() ?? Promise.resolve({}))
      : Promise.resolve({}),
  );
}

function rejectPublications(client: CapturedClient, message: string, methods = optionalMethods) {
  client.request.mockImplementation(async (method) => {
    if (methods.includes(method)) {
      throw new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: message.replace("$method", method),
      });
    }
    return {};
  });
}

function enableSkills() {
  mocks.nodeSkillDescriptors = [
    {
      name: "release-helper",
      description: "Prepare a release",
      content: "---\nname: release-helper\ndescription: Prepare a release\n---\n",
    },
  ];
}

describe("runNodeHost", () => {
  beforeEach(resetRunnerTestState);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("retains managed state admission while an external signal closes the runtime", async () => {
    mocks.useFakeRuntime = true;
    const statePath = resolveOpenClawStateSqlitePath();
    let cleanupStatePath: string | undefined;
    mocks.activeRuntime.close.mockImplementationOnce(async () => {
      cleanupStatePath = getExistingOpenClawStateSchemaPath();
    });
    await withReadyNodeHost(
      async ({ running, stop }) => {
        expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
        stop();
        await running;
        expect(cleanupStatePath).toBe(statePath);
        expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
        expect(getExistingOpenClawStateSchemaPath()).toBeUndefined();
      },
      {},
      undefined,
      (options) => withExistingOpenClawStateSchema({ path: statePath }, () => runNodeHost(options)),
    );
  });

  it("joins the source node runtime when its companion stdin closes", async () => {
    mocks.useFakeRuntime = true;
    const input = new PassThrough();
    const previous = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    try {
      await withReadyNodeHost(
        async ({ running, client }) => {
          await vi.waitFor(() => expect(input.listenerCount("end")).toBe(1));
          input.end();
          await running;
          expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
          expect(client.stopAndWait).toHaveBeenCalledOnce();
          expect(input.listenerCount("end")).toBe(0);
        },
        { parentStdin: true },
        () => input.end(),
      );
    } finally {
      if (previous) {
        Object.defineProperty(process, "stdin", previous);
      }
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
        await expectCalls(mocks.configureNodeHost, 2);
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
    const config = remoteConfig({ token: "remote-token", password: "remote-password" }, "local");
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
    mocks.getRuntimeConfig.mockReturnValue(
      remoteConfig({ token: "other-gateway-token", password: "other-gateway-password" }),
    );
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", undefined);
    await expectStartupTimeout({
      gatewayHost: "selected.example",
      gatewayPort: 443,
      gatewayTls: true,
      gatewayAuthFromEnv: true,
    });
    expect(lastCapturedOptions()).toMatchObject({ token: undefined, password: undefined });
    expect(mocks.resolveGatewayCredentialsWithSecretInputs).not.toHaveBeenCalled();
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
        role === "node" ? pairedToken : null,
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
      mocks.resolveGatewayCredentialsWithSecretInputs.mockResolvedValue({});
    });

    it("offers the saved endpoint for resume only with a paired node credential", async () => {
      mocks.loadDeviceIdentityIfPresent.mockResolvedValue(deviceIdentity);
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
        mocks.loadDeviceIdentityIfPresent.mockResolvedValue(deviceIdentity);
      });

      it("never falls back to shared auth if the saved token disappears before connect", async () => {
        mocks.loadDeviceAuthTokenReadOnly
          .mockResolvedValueOnce(pairedToken)
          .mockResolvedValue(null);
        vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "shared-test-token");

        await expectStartupTimeout(expiredOptions);

        expect(connectAuth()).toMatchObject({
          deviceToken: "paired-node-token",
          bootstrapToken: undefined,
        });
        // GatewayClient rereads native auth when connecting; the token can be gone by then.
        const stored = await mocks.loadDeviceAuthTokenReadOnly({
          deviceId: "device-test",
          role: "node",
        });
        expect(lastCapturedOptions()?.bootstrapToken).toBeUndefined();
        const auth = buildGatewayConnectAuth(
          selectGatewayConnectAuth({ ...lastCapturedOptions(), storedToken: stored?.token }),
        );
        expect(auth).toBeUndefined();
        expect(mocks.resolveGatewayCredentialsWithSecretInputs).not.toHaveBeenCalled();
      });

      it.each<[string, () => unknown, Partial<Parameters<typeof runNodeHost>[0]>]>([
        ["missing identity", () => mocks.loadDeviceIdentityIfPresent.mockResolvedValue(null), {}],
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

    it("restarts a paired service without inheriting ambient credentials", async () => {
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "unrelated-gateway-token");
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "unrelated-gateway-password");
      await expectStartupTimeout(runOptions);

      expect(connectAuth()).toMatchObject({
        deviceToken: "paired-node-token",
        token: undefined,
        password: undefined,
      });
      expect(mocks.resolveGatewayCredentialsWithSecretInputs).not.toHaveBeenCalled();
      expect(lastCapturedOptions()?.deviceToken).toBeUndefined();
    });

    it("uses explicitly requested environment auth instead of the paired token", async () => {
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "explicit-gateway-token");
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      await expectStartupTimeout({ ...runOptions, gatewayAuthFromEnv: true });
      expect(connectAuth()).toMatchObject({
        token: "explicit-gateway-token",
        deviceToken: undefined,
      });
      const warning = stderr.mock.calls.map(([message]) => String(message)).join("");
      expect(warning).toContain("--auth-from-env selects OPENCLAW_GATEWAY_TOKEN");
      expect(warning).not.toContain("explicit-gateway-token");
    });

    it("keeps remote-mode credentials when selecting another Gateway", async () => {
      mocks.getRuntimeConfig.mockReturnValue(
        remoteConfig({ url: "wss://another.example:443", token: "remote-token" }),
      );
      mocks.resolveGatewayCredentialsWithSecretInputs.mockResolvedValue({ token: "remote-token" });

      await expectStartupTimeout({ ...runOptions, gatewayHost: "another.example" });

      expect(lastCapturedOptions()?.token).toBe("remote-token");
      expect(mocks.resolveGatewayCredentialsWithSecretInputs).toHaveBeenCalledOnce();
    });
  });

  it.each(["signal", "terminal reconnect pause"])(
    "drains MCP before exit on %s",
    async (reason) => {
      const unref = vi.fn();
      const interval = { unref } as unknown as ReturnType<typeof setInterval>;
      const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(interval);
      const clearIntervalSpy = vi.spyOn(global, "clearInterval").mockImplementation(() => {});
      const readiness = createDeferred<ReturnType<typeof mocks.readiness>>();
      const mcpClose = createDeferred<undefined>();
      mocks.startGatewayClientWhenEventLoopReady.mockReturnValueOnce(readiness.promise);
      mocks.closeMcpManager.mockReturnValueOnce(mcpClose.promise);
      const exit = vi.spyOn(oneShotExit, "requestExitAfterOneShotOutput").mockReturnValue(true);
      await withReadyNodeHost(
        async ({ running, stop, client, options }) => {
          await vi.waitFor(() => expect(startNodeHostMcpManager).toHaveBeenCalled());
          expect(setIntervalSpy).toHaveBeenCalledOnce();
          expect(unref).not.toHaveBeenCalled();
          expect(clearIntervalSpy).not.toHaveBeenCalledWith(interval);
          if (reason === "signal") {
            readiness.resolve(mocks.readiness(true));
            expect(stop()).toBeTypeOf("function");
          } else {
            options.onReconnectPaused?.({
              code: 1008,
              reason: "connect failed",
              detailCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
            });
          }
          await expectCalls(client.stopAndWait);
          expect(clearIntervalSpy).not.toHaveBeenCalledWith(interval);
          await expectCalls(mocks.closeMcpManager);
          expect(exit).not.toHaveBeenCalled();
          mcpClose.resolve(undefined);
          if (reason !== "signal") {
            await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(undefined, 1));
          }
          readiness.resolve(mocks.readiness(false));
          await expect(running).resolves.toBeUndefined();
          expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
          expect(mocks.closeMcpManager).toHaveBeenCalledOnce();
          expect(client.stopAndWait).toHaveBeenCalledOnce();
          expect(process.exitCode).toBe(reason === "signal" ? 143 : 1);
        },
        {},
        () => {
          mcpClose.resolve(undefined);
          readiness.resolve(mocks.readiness(false));
        },
      );
    },
  );

  it("keeps pairing reconnect pauses visible without stopping the foreground host", async () => {
    await expectStartupTimeout();
    mocks.closeMcpManager.mockClear();
    mocks.capturedGatewayClients[0]?.stopAndWait.mockClear();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
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
  });

  it.each([
    ["::1", "gws", "ws://[::1]:18789/gws"],
    ["[::1]", "/gws/", "ws://[::1]:18789/gws/"],
  ])("formats Gateway endpoint %s%s", async (gatewayHost, gatewayContextPath, expectedUrl) => {
    await expectStartupTimeout({ gatewayHost, gatewayContextPath });
    expect(lastCapturedOptions()?.url).toBe(expectedUrl);
    expect(mocks.capturedConfiguredGatewayConfigs.at(-1)?.contextPath).toBe(gatewayContextPath);
  });

  it("resets permanent rejection streaks on transient failures and hello, exiting only at three", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const permanentRejection = upgradeError({
        httpStatus: 403,
        gatewayErrorType: "proxy_attribution_required",
        gatewayErrorMessage: "Configure gateway.trustedProxies narrowly",
      });
      const rejectTwice = () => {
        options?.onConnectError?.(permanentRejection);
        options?.onConnectError?.(permanentRejection);
      };
      const transientErrors = [
        new Error("connect ECONNRESET"),
        ...[
          { httpStatus: 429, gatewayErrorType: "rate_limited" },
          { httpStatus: 503, gatewayErrorType: "proxy_attribution_required" },
          { httpStatus: 403 },
          { httpStatus: 403, gatewayErrorType: "another_rejection" },
        ].map(upgradeError),
      ];
      for (const transientError of transientErrors) {
        rejectTwice();
        options?.onConnectError?.(transientError);
        expect(client.stopAndWait).not.toHaveBeenCalled();
      }
      rejectTwice();
      receiveHello(options);
      rejectTwice();
      expect(client.stopAndWait).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("permanently rejected"));
      options?.onConnectError?.(permanentRejection);
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(client.stopAndWait).toHaveBeenCalledOnce();
      expect(mocks.closeMcpManager).toHaveBeenCalledOnce();
      expect(stderr).toHaveBeenCalledWith(
        "node host gateway permanently rejected connection (proxy_attribution_required): Configure gateway.trustedProxies narrowly; exiting\n",
      );
    });
  });

  it("treats exact v3 authorization failures as unsupported optional publications", async () => {
    enableSkills();
    await withReadyNodeHost(async ({ client, options }) => {
      rejectPublications(client, "unauthorized role: node");
      receiveHello(options, 3);
      await expectPublications(client, 1);
      mocks.availabilityChanged?.();
      await settlePublications();
      for (const method of optionalMethods) {
        expect(getPublications(client, method)).toHaveLength(1);
      }
      client.request.mockResolvedValue({});
      options?.onClose?.(1000, "legacy gateway closed");
      receiveHello(options);
      await vi.waitFor(() => {
        for (const method of optionalMethods) {
          expect(getPublications(client, method)).toHaveLength(2);
        }
      });
    });
  });

  it("fails closed without flooding on exact v4 authorization failures", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      rejectPublications(client, "unauthorized role: node", [NODE_PLUGIN_TOOLS_UPDATE_METHOD]);
      receiveHello(options);
      await expectPublications(client, 1);
      for (let index = 0; index < 10; index += 1) {
        mocks.availabilityChanged?.();
      }
      await settlePublications();
      expect(getPublications(client)).toHaveLength(1);
      changeTools([]);
      await expectPublications(client, 2);
      mocks.availabilityChanged?.();
      await settlePublications();
      expect(getPublications(client)).toHaveLength(2);
    });
  });

  it("deduplicates inventory when the desired value returns to the in-flight value", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const initialPluginTools = [...mocks.nodePluginTools];
      const initial = createDeferred<unknown>();
      await beginPublication(client, options, initial.promise);
      changeTools([]);
      changeTools(initialPluginTools);
      initial.resolve({});
      await settlePublications();
      await settlePublications();
      expect(getPublications(client)).toEqual([
        [NODE_PLUGIN_TOOLS_UPDATE_METHOD, { tools: initialPluginTools }],
      ]);
      mocks.availabilityChanged?.();
      await settlePublications();
      expect(getPublications(client)).toHaveLength(1);
    });
  });

  it("republishes an acknowledged value after an ambiguous different-value failure", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const initialPluginTools = [...mocks.nodePluginTools];
      const changed = createDeferred<unknown>();
      await beginPublication(client, options, Promise.resolve({}), changed.promise);
      await settlePublications();
      changeTools([]);
      await expectPublications(client, 2);
      changed.reject(new Error("publication outcome unknown"));
      await settlePublications();
      changeTools(initialPluginTools);
      await vi.waitFor(() => {
        const publications = getPublications(client);
        expect(publications.length).toBeGreaterThanOrEqual(3);
        expect(publications.at(-1)?.[1]).toEqual({ tools: initialPluginTools });
      });
    });
  });

  it.each([
    [3, new Error("temporary publish failure")],
    [4, new GatewayClientRequestError({ code: "INVALID_REQUEST", message: "validation failure" })],
  ] as const)(
    "retains queued inventory across a v%s publication failure: %s",
    async (protocol, error) => {
      await withReadyNodeHost(async ({ client, options }) => {
        const initialPluginTools = [...mocks.nodePluginTools];
        const initial = createDeferred<unknown>();
        const second = createDeferred<unknown>();
        queuePluginResponses(client, initial.promise, second.promise);
        receiveHello(options, protocol);
        await expectPublications(client, 1);
        changeTools([]);
        initial.reject(error);
        await expectPublications(client, 2);
        expect(client.request).toHaveBeenCalledWith(NODE_PLUGIN_TOOLS_UPDATE_METHOD, { tools: [] });
        changeTools(initialPluginTools);
        second.resolve({});
        await vi.waitFor(() => {
          const publications = getPublications(client);
          expect(publications).toHaveLength(3);
          expect(publications.at(-1)?.[1]).toEqual({ tools: initialPluginTools });
        });
      });
    },
  );

  it("retires in-flight inventory before manifest reconnect", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const initial = createDeferred<unknown>();
      queuePluginResponses(client, initial.promise);
      receiveHello(options, 3);
      await expectPublications(client, 1);
      await settlePublications();
      Object.assign(mocks, { nodePluginTools: [], nodeHostCaps: ["canvas"] });
      mocks.availabilityChanged?.();
      initial.resolve({});
      await settlePublications();
      expect(getPublications(client)).toHaveLength(1);
      receiveHello(options, 3);
      await expectPublications(client, 2);
      expect(client.request).toHaveBeenLastCalledWith(NODE_PLUGIN_TOOLS_UPDATE_METHOD, {
        tools: [],
      });
    });
  });
});
