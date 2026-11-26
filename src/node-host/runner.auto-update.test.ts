import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { VERSION } from "../version.js";
import type { PreparedNodeRuntimeUpdate } from "./auto-update-install.js";
import "./auto-update.js";
import {
  expectCalls,
  mocks,
  receiveHello,
  resetRunnerTestState,
  withReadyNodeHost,
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

// mock-isolation: update tests supply prepared candidates without installing a real runtime.
vi.mock("./auto-update-install.js", () => ({ prepareNodeRuntimeUpdate: updateMocks.prepare }));

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

async function withRunningNodeHost(
  options: Parameters<typeof withReadyNodeHost>[1],
  runTest: Parameters<typeof withReadyNodeHost>[0],
) {
  await withReadyNodeHost(
    async (host) => {
      expect(mocks.startGatewayClientWhenEventLoopReady).toHaveBeenCalledOnce();
      expect(updateMocks.discover).not.toHaveBeenCalled();
      expect(updateMocks.send).not.toHaveBeenCalled();
      await runTest(host);
    },
    { gatewayHost: "gateway.example", gatewayPort: 443, ...options },
    () => {
      process.emit("message", {
        type: "openclaw.node.restart-result",
        ok: false,
        error: "test cleanup",
      });
    },
  );
}

describe("node runner auto-update handoff", () => {
  beforeEach(() => {
    resetRunnerTestState();
    mocks.useFakeRuntime = true;
    mocks.activeRuntime.tryPauseForUpdate.mockReset().mockResolvedValue(true);
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

  it.each([true, false])(
    "warns about a legacy entrypoint only when updates are enabled (%s)",
    async (enabled) => {
      Object.defineProperty(process, "connected", { configurable: true, value: false });
      const argv = process.argv;
      process.argv = [process.execPath, "/installed/openclaw/dist/index.js", "node", "run"];
      mocks.getRuntimeConfig.mockReturnValue({ nodeHost: { autoUpdate: { enabled } } });
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await withRunningNodeHost({}, async () => {
          const warned = stderr.mock.calls.some(([line]) =>
            String(line).includes("bypasses the node launcher"),
          );
          expect(warned).toBe(enabled);
        });
      } finally {
        process.argv = argv;
        stderr.mockRestore();
      }
    },
  );

  it.each([true, false])(
    "restarts with effective options (TLS/companion=%s) without replaying pairing",
    async (companion) => {
      const commands = companion ? ["fixture.list", "fixture.read"] : undefined;
      const gateway = companion
        ? {
            host: "2001:db8::10",
            port: 8443,
            tls: true,
            tlsFingerprint: "ab".repeat(32),
            contextPath: "/openclaw-gw",
          }
        : { host: "127.0.0.1", port: 18789, tls: false };
      const optionArgs = companion
        ? `--tls --share-installed-apps --context-path /openclaw-gw --tls-fingerprint ${"ab".repeat(32)} --commands fixture.list,fixture.read --session-host --desktop-sharing --auth-from-env --parent-stdin`.split(
            " ",
          )
        : "--no-tls --no-share-installed-apps --no-desktop-sharing".split(" ");
      const effectiveConfig = {
        version: 1 as const,
        nodeId: "persisted-node-id",
        displayName: "Persisted Node",
        gateway,
        installedAppsSharing: companion,
        commands,
      };
      mocks.configureNodeHost.mockResolvedValueOnce(effectiveConfig);
      mocks.activeRuntime.tryPauseForUpdate.mockResolvedValueOnce(false);

      await withRunningNodeHost(
        {
          gatewayBootstrapToken: "one-use-bootstrap-token",
          preferGatewayBootstrapToken: true,
          forceWorkerRuns: companion,
          desktopSharingEnabled: companion,
          gatewayAuthFromEnv: companion,
          parentStdin: companion,
          allCommands: commands === undefined,
        },
        async () => {
          receiveHello(undefined, 1);
          await expectCalls(mocks.activeRuntime.tryPauseForUpdate);

          expect(updateMocks.send.mock.calls.map(([message]) => message)).toEqual([
            {
              type: "openclaw.node.restart-args",
              argv: [
                "node",
                "run",
                "--host",
                gateway.host,
                "--port",
                String(gateway.port),
                "--node-id",
                "persisted-node-id",
                "--display-name",
                "Persisted Node",
                ...optionArgs,
              ],
            },
            { type: "openclaw.node.ready", version: VERSION },
          ]);
        },
      );
    },
  );

  it("does not schedule updates for service enrollment", async () => {
    await withRunningNodeHost({ stopAfterFirstConnect: true }, async ({ running, stop }) => {
      receiveHello(undefined, 1);
      stop();
      await running;

      expect(updateMocks.send).not.toHaveBeenCalled();
      expect(updateMocks.discover).not.toHaveBeenCalled();
      expect(updateMocks.prepare).not.toHaveBeenCalled();
    });
  });

  it.each(["parent acceptance", "shutdown signal"] as const)(
    "joins the in-flight update before closing after %s",
    async (completion) => {
      const installing = createDeferred<PreparedNodeRuntimeUpdate>();
      updateMocks.prepare.mockReturnValueOnce(installing.promise);
      await withRunningNodeHost({}, async ({ running, stop }) => {
        try {
          receiveHello(undefined, 1);
          await expectCalls(updateMocks.prepare);
          const updateSignal = updateMocks.prepare.mock.calls[0]?.[0].signal;

          let onSigterm: (() => void) | undefined;
          if (completion === "shutdown signal") {
            onSigterm = stop();
            expect(onSigterm).toBeDefined();
            expect(process.listeners("SIGTERM")).toContain(onSigterm);
            stop();
            expect(process.listeners("SIGTERM")).toContain(onSigterm);
            expect(updateSignal?.aborted).toBe(true);
          } else {
            installing.resolve(candidate);
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
          }
          expect(mocks.capturedGatewayClients[0]?.stopAndWait).not.toHaveBeenCalled();
          expect(mocks.activeRuntime.close).not.toHaveBeenCalled();

          installing.resolve(candidate);
          if (completion === "parent acceptance") {
            process.emit("message", { type: "openclaw.node.restart-result", ok: true });
          }
          await running;

          expect(mocks.capturedGatewayClients[0]?.stopAndWait).toHaveBeenCalledOnce();
          expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
          if (completion === "shutdown signal") {
            expect(process.listeners("SIGTERM")).not.toContain(onSigterm);
            expect(mocks.activeRuntime.tryPauseForUpdate).not.toHaveBeenCalled();
            expect(updateMocks.send.mock.calls.map(([message]) => message)).not.toContainEqual(
              expect.objectContaining({ type: "openclaw.node.restart" }),
            );
          } else {
            expect(mocks.activeRuntime.resumeAfterUpdate).not.toHaveBeenCalled();
          }
          expect(process.exitCode).toBe(completion === "shutdown signal" ? 143 : 0);
        } finally {
          installing.resolve(candidate);
        }
      });
    },
  );
});
