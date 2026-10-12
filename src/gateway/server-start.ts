import { formatErrorMessage } from "../infra/errors.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { createGatewayKernel, gatewayKernelLogs } from "./server-kernel.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import { createGatewayHttpTransport } from "./server-runtime-state.js";
import { rethrowGatewayStartupError, runGatewayCloseSteps } from "./server-shutdown.js";
import { finishGatewayStartup } from "./server-startup-finish.js";
import { beginMacOSSystemCaWarmupOnce } from "./system-ca-warmup.js";

const { log, logTailscale, logChannels, logHealth, logCron, logReload, logHooks, logWsControl } =
  gatewayKernelLogs;
const POST_READY_WORK_START_DELAY_MS = 500;

export async function startGatewayServerCore(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  const sdkResourceHost = new LegacyPluginSdkResourceHost();
  // Join startup through its returned promise without giving resident listeners the boot scope.
  const start = (signal?: AbortSignal) =>
    runOutsideAsyncWorkScope(() =>
      startGatewayServerWithSdkHost(port, opts, sdkResourceHost, signal),
    );
  return await sdkResourceHost.run(() =>
    opts.startupOperation ? opts.startupOperation(start) : start(),
  );
}

async function startGatewayServerWithSdkHost(
  port: number,
  opts: GatewayServerOptions,
  sdkResourceHost: LegacyPluginSdkResourceHost,
  signal?: AbortSignal,
): Promise<GatewayServer> {
  const { promise: postReadyWorkBarrier, resolve: releasePostReadyWork } = createDeferredCore();
  const gatewayKernel = await createGatewayKernel(port, opts, {
    deferEarlyRuntime: true,
    sdkResourceHost,
  });
  // A Gateway restart must refresh restored skill catalogs, even in the same process.
  bumpSkillsSnapshotVersion({ reason: "manual" });
  if (!gatewayKernel.minimalTestGateway) {
    // Start the Keychain read early so it overlaps bootstrap; post-attach awaits the
    // shared promise before plugins can use TLS.
    void beginMacOSSystemCaWarmupOnce({ log });
  }
  let startupSettled: Promise<void>;
  let tailscaleStopping: Promise<void> | undefined;
  let stopStartingTailscale: (() => void) | undefined;
  const { closeOnStartupFailure, prepareClose, terminalSessions, shutdownRuntime } = gatewayKernel;
  try {
    const transport = await createGatewayHttpTransport({
      ...gatewayKernel.createHttpTransportOptions(),
      httpRequestLifetime: gatewayKernel.gatewayRequestContext,
      updateCanary: opts.updateCanary,
      ...(!gatewayKernel.minimalTestGateway && gatewayKernel.tailscaleMode !== "off"
        ? {
            prepareManagedTailscaleIngress: async (backend) => {
              const { startGatewayTailscaleExposure } = await import("./server-tailscale.js");
              const cleanup = await startGatewayTailscaleExposure({
                tailscaleMode: gatewayKernel.tailscaleMode,
                preserveFunnel: gatewayKernel.tailscaleConfig.preserveFunnel ?? false,
                port,
                backend,
                controlUiBasePath: gatewayKernel.controlUiBasePath,
                logTailscale,
                signal,
              });
              gatewayKernel.kernel.setTailscaleCleanup(cleanup);
              stopStartingTailscale = () => {
                tailscaleStopping ??= cleanup?.();
                void tailscaleStopping?.catch(() => {});
              };
              // Keep cancellation ownership until the full server close handle is published.
              signal?.addEventListener("abort", stopStartingTailscale, { once: true });
              if (signal?.aborted) {
                stopStartingTailscale();
                signal.throwIfAborted();
              }
            },
          }
        : {}),
    });
    gatewayKernel.transportBridge.attach(transport);
    const startup = await finishGatewayStartup({
      kernelRuntime: { ...gatewayKernel, ...transport },
      port,
      opts,
      bootId: gatewayKernel.bootId,
      log,
      logHealth,
      logWsControl,
      logHooks,
      logChannels,
      logCron,
      logReload,
      waitForPostReadyWork: () => postReadyWorkBarrier,
    });
    startupSettled = startup.startupSettled;
    signal?.throwIfAborted();
  } catch (err) {
    // Failed startup must release work whose normal timer was never armed.
    releasePostReadyWork();
    return await rethrowGatewayStartupError(err, closeOnStartupFailure);
  } finally {
    if (stopStartingTailscale) {
      signal?.removeEventListener("abort", stopStartingTailscale);
    }
    await tailscaleStopping;
  }
  void startupSettled.then(
    () => {
      if (gatewayKernel.lifecycle.closePreludeStarted) {
        return;
      }
      // Deferred sidecars must finish before the I/O window for background work begins.
      gatewayKernel.scheduler.schedule({
        id: "startup:post-ready-work",
        delayMs: POST_READY_WORK_START_DELAY_MS,
        run: releasePostReadyWork,
      });
    },
    // The caller owns deferred startup failure; close releases the background waiters.
    () => {},
  );

  let closePromise: Promise<void> | undefined;

  return {
    startupSettled,
    getTailscaleIngressEndpoint: gatewayKernel.transportBridge.getTailscaleIngressEndpoint,
    close: (optsLocal) => {
      if (!closePromise) {
        closePromise = sdkResourceHost
          .run(async () => {
            const preparedClose = prepareClose(optsLocal);
            releasePostReadyWork();
            await runGatewayCloseSteps({
              owner: gatewayKernel,
              close: await preparedClose,
              disposeTerminalSessions: () => terminalSessions.disposeAll(),
              runStopHooks: async () => {
                await shutdownRuntime.runGlobalGatewayStopSafely({
                  registry: gatewayKernel.pluginRuntime.registry,
                  event: { reason: optsLocal?.reason ?? "gateway stopping" },
                  ctx: { port },
                  onError: (error) =>
                    log.warn(`gateway_stop hook failed: ${formatErrorMessage(error)}`),
                });
              },
              onError: (message) => log.error(message),
            });
          })
          .catch((error: unknown) => {
            if (hasRetainedPluginRuntimeCloseError(error)) {
              closePromise = undefined;
            }
            throw error;
          });
      }
      return closePromise;
    },
  };
}
