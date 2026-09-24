import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import { VERSION } from "../version.js";
import type { PreparedNodeRuntimeUpdate } from "./auto-update-install.js";
import "./auto-update.js";
import {
  lastCapturedOptions,
  mocks,
  resetRunnerTestState,
  runNodeHost,
} from "./runner.test-support.js";

const updateMocks = vi.hoisted(() => ({
  prepare: vi.fn<typeof import("./auto-update-install.js").prepareNodeRuntimeUpdate>(),
  discover: vi.fn(async () => ({ version: "9999.1.0" })),
  assertCompatible: vi.fn(async () => undefined),
  send: vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
    callback(null);
    return true;
  }),
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  createConfigIO: () => ({
    readConfigFileSnapshot: async () => ({
      valid: true,
      config: { update: { channel: "stable" } },
    }),
  }),
}));

vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => "/installed/openclaw",
}));

vi.mock("../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-check.js")>()),
  resolveUpdateInstallKind: async () => "package",
  resolveNpmChannelTag: updateMocks.discover,
}));

vi.mock("./auto-update-install.js", () => ({
  prepareNodeRuntimeUpdate: updateMocks.prepare,
}));

vi.mock("./auto-update-compatibility.js", () => ({
  assertNodeRuntimeUpdateCompatible: updateMocks.assertCompatible,
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
const launcherChildMarker = Symbol.for("openclaw.node-host.launcher-child");
const launcherProperties = [launcherChildMarker, "connected", "send"] as const;
let originalLauncherProperties: Map<PropertyKey, PropertyDescriptor | undefined>;

const candidate: PreparedNodeRuntimeUpdate = {
  runtimeRoot: "/node-runtime/releases/9999.1.0",
  packageRoot: "/node-runtime/releases/9999.1.0/lib/node_modules/openclaw",
  version: "9999.1.0",
  integrity: "sha512-test",
};

function hello() {
  const response: Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0] = {
    type: "hello-ok",
    protocol: 1,
    server: { version: VERSION, connId: "node-update-test" },
    features: { methods: [], events: [] },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "node", scopes: [] },
    policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
  };
  lastCapturedOptions()?.onHelloOk?.(response);
}

async function withRunningNodeHost(
  options: Partial<Parameters<typeof runNodeHost>[0]>,
  runTest: (host: {
    running: Promise<void>;
    stop: () => (() => void) | undefined;
  }) => Promise<void>,
) {
  const processOnSpy = vi.spyOn(process, "on");
  const previousExitCode = process.exitCode;
  const running = runNodeHost({ gatewayHost: "gateway.example", gatewayPort: 443, ...options });
  const stop = () => {
    const listener = processOnSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
    listener?.("SIGTERM");
    return listener;
  };
  try {
    await vi.waitFor(() =>
      expect(mocks.startGatewayClientWhenEventLoopReady).toHaveBeenCalledOnce(),
    );
    expect(updateMocks.discover).not.toHaveBeenCalled();
    expect(updateMocks.send).not.toHaveBeenCalled();
    await runTest({ running, stop });
  } finally {
    process.emit("message", {
      type: "openclaw.node.restart-result",
      ok: false,
      error: "test cleanup",
    });
    stop();
    try {
      await running;
    } finally {
      for (const [event, listener] of processOnSpy.mock.calls) {
        if (event === "SIGINT" || event === "SIGTERM") {
          process.off(event, listener);
        }
      }
      process.exitCode = previousExitCode;
      processOnSpy.mockRestore();
    }
  }
}

describe("node runner auto-update handoff", () => {
  beforeEach(() => {
    resetRunnerTestState();
    mocks.useFakeRuntime = true;
    mocks.activeRuntime.tryPauseForUpdate.mockReset().mockResolvedValue(true);
    mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
      elapsedMs: 0,
    });
    updateMocks.prepare.mockReset().mockResolvedValue(candidate);
    vi.stubEnv("OPENCLAW_STATE_DIR", temporary.make("node-runner-update-"));
    vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", undefined);
    vi.stubEnv("OPENCLAW_NO_RESPAWN", undefined);
    originalLauncherProperties = new Map(
      launcherProperties.map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]),
    );
    Object.defineProperties(process, {
      [launcherChildMarker]: { configurable: true, value: true },
      connected: { configurable: true, value: true },
      send: { configurable: true, value: updateMocks.send },
    });
  });

  afterEach(() => {
    for (const [key, descriptor] of originalLauncherProperties) {
      if (descriptor) {
        Object.defineProperty(process, key, descriptor);
      } else {
        Reflect.deleteProperty(process, key);
      }
    }
    vi.unstubAllEnvs();
  });

  it.each([
    {
      label: "TLS, a context path, and process-local worker hosting",
      gateway: {
        host: "2001:db8::10",
        port: 8443,
        tls: true,
        tlsFingerprint: "ab".repeat(32),
        contextPath: "/openclaw-gw",
      },
      sharing: true,
      commands: ["fixture.list", "fixture.read"],
      forceWorkerRuns: true,
      desktopSharingEnabled: true,
      companion: true,
      endpointArgs: ["--host", "2001:db8::10", "--port", "8443"],
      optionArgs: [
        "--tls",
        "--share-installed-apps",
        "--context-path",
        "/openclaw-gw",
        "--tls-fingerprint",
        "ab".repeat(32),
        "--commands",
        "fixture.list,fixture.read",
        "--session-host",
        "--desktop-sharing",
        "--auth-from-env",
        "--parent-stdin",
      ],
    },
    {
      label: "plaintext and the restored full command surface",
      gateway: { host: "127.0.0.1", port: 18789, tls: false },
      sharing: false,
      commands: undefined,
      forceWorkerRuns: false,
      desktopSharingEnabled: false,
      companion: false,
      endpointArgs: ["--host", "127.0.0.1", "--port", "18789"],
      optionArgs: ["--no-tls", "--no-share-installed-apps", "--no-desktop-sharing"],
    },
  ])("restarts with effective options for $label without replaying pairing", async (entry) => {
    const effectiveConfig = {
      version: 1 as const,
      nodeId: "persisted-node-id",
      displayName: "Persisted Node",
      gateway: entry.gateway,
      installedAppsSharing: entry.sharing,
      commands: entry.commands,
    };
    mocks.configureNodeHost.mockResolvedValueOnce(effectiveConfig);
    mocks.activeRuntime.tryPauseForUpdate.mockResolvedValueOnce(false);

    await withRunningNodeHost(
      {
        gatewayBootstrapToken: "one-use-bootstrap-token",
        preferGatewayBootstrapToken: true,
        forceWorkerRuns: entry.forceWorkerRuns,
        desktopSharingEnabled: entry.desktopSharingEnabled,
        gatewayAuthFromEnv: entry.companion,
        parentStdin: entry.companion,
        allCommands: entry.commands === undefined,
      },
      async () => {
        hello();
        await vi.waitFor(() =>
          expect(mocks.activeRuntime.tryPauseForUpdate).toHaveBeenCalledOnce(),
        );

        expect(updateMocks.send.mock.calls.map(([message]) => message)).toEqual([
          {
            type: "openclaw.node.restart-args",
            argv: [
              "node",
              "run",
              ...entry.endpointArgs,
              "--node-id",
              "persisted-node-id",
              "--display-name",
              "Persisted Node",
              ...entry.optionArgs,
            ],
          },
          { type: "openclaw.node.ready", version: VERSION },
        ]);
      },
    );
  });

  it("closes the foreground runner only after its parent accepts the prepared runtime", async () => {
    await withRunningNodeHost({}, async ({ running }) => {
      hello();
      await vi.waitFor(() =>
        expect(updateMocks.send).toHaveBeenCalledWith(
          {
            type: "openclaw.node.restart",
            runtimeRoot: candidate.runtimeRoot,
            version: candidate.version,
          },
          expect.any(Function),
        ),
      );
      expect(mocks.capturedGatewayClients[0]?.stop).not.toHaveBeenCalled();
      expect(mocks.activeRuntime.close).not.toHaveBeenCalled();

      process.emit("message", { type: "openclaw.node.restart-result", ok: true });
      await running;

      expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalledOnce();
      expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
      expect(mocks.activeRuntime.resumeAfterUpdate).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    });
  });

  it.each([
    { label: "service enrollment", stopAfterFirstConnect: true },
    { label: "an ephemeral worker", ephemeral: true },
  ])("does not schedule updates for $label", async ({ label: _label, ...options }) => {
    await withRunningNodeHost(options, async ({ running, stop }) => {
      hello();
      stop();
      await running;

      expect(updateMocks.send).not.toHaveBeenCalled();
      expect(updateMocks.discover).not.toHaveBeenCalled();
      expect(updateMocks.prepare).not.toHaveBeenCalled();
    });
  });

  it("keeps repeated shutdown signals handled until an in-flight update has settled", async () => {
    const installing = createDeferred<PreparedNodeRuntimeUpdate>();
    updateMocks.prepare.mockReturnValueOnce(installing.promise);
    await withRunningNodeHost({}, async ({ running, stop }) => {
      try {
        hello();
        await vi.waitFor(() => expect(updateMocks.prepare).toHaveBeenCalledOnce());
        const updateSignal = updateMocks.prepare.mock.calls[0]?.[0].signal;

        const onSigterm = stop();
        expect(onSigterm).toBeDefined();
        expect(process.listeners("SIGTERM")).toContain(onSigterm);
        stop();
        expect(process.listeners("SIGTERM")).toContain(onSigterm);
        expect(updateSignal?.aborted).toBe(true);
        expect(mocks.capturedGatewayClients[0]?.stop).not.toHaveBeenCalled();
        expect(mocks.activeRuntime.close).not.toHaveBeenCalled();

        installing.resolve(candidate);
        await running;

        expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalledOnce();
        expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
        expect(process.listeners("SIGTERM")).not.toContain(onSigterm);
        expect(mocks.activeRuntime.tryPauseForUpdate).not.toHaveBeenCalled();
        expect(updateMocks.send.mock.calls.map(([message]) => message)).not.toContainEqual(
          expect.objectContaining({ type: "openclaw.node.restart" }),
        );
        expect(process.exitCode).toBe(143);
      } finally {
        installing.resolve(candidate);
      }
    });
  });
});
