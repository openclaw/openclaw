import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { hasRetainedPluginRuntimeCloseError } from "../plugins/runtime-close-error.js";
import {
  retireGatewayWriterAdmission,
  publishGatewayReaderAdmission,
  retireGatewayReaderAdmission,
  isGatewayReadAdmissionAvailable,
  runWithGatewayWriterRetirementCleanup,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { bumpSkillsSnapshotVersion } from "../skills/runtime/refresh-state.js";
import { getGatewayProcessInstanceId } from "./process-instance.js";
import { createGatewayKernel, gatewayKernelLogs } from "./server-kernel.js";
import type {
  GatewayReaderRequest,
  GatewayReaderReceipt,
  GatewayServer,
  GatewayServerOptions,
} from "./server-public.js";
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
  return await sdkResourceHost.run(() =>
    startGatewayServerWithSdkHost(port, opts, sdkResourceHost),
  );
}

async function startGatewayServerWithSdkHost(
  port: number,
  opts: GatewayServerOptions,
  sdkResourceHost: LegacyPluginSdkResourceHost,
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
  const { closeOnStartupFailure, prepareClose, terminalSessions, shutdownRuntime } = gatewayKernel;
  try {
    const transport = await createGatewayHttpTransport({
      ...gatewayKernel.createHttpTransportOptions(),
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
              });
              // The server close handle is not published until this callback settles.
              // Startup failure therefore owns teardown before normal close can race it.
              gatewayKernel.kernel.setTailscaleCleanup(cleanup);
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
  } catch (err) {
    // Failed startup must release work whose normal timer was never armed.
    releasePostReadyWork();
    return await rethrowGatewayStartupError(err, closeOnStartupFailure);
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
  let readerPromise: Promise<GatewayReaderReceipt> | undefined;
  let readerRequest: GatewayReaderRequest | undefined;
  let readerTimer: ReturnType<typeof setTimeout> | undefined;
  const assertReaderTarget = (request: GatewayReaderRequest) => {
    if (
      request.target.pid !== process.pid ||
      request.target.processInstanceId !== getGatewayProcessInstanceId()
    ) {
      throw new Error("Gateway reader process changed after preflight");
    }
    const remaining = request.expiresAtMs - Date.now();
    if (!Number.isSafeInteger(request.expiresAtMs) || remaining <= 0 || remaining > 2940_000) {
      throw new Error(
        "Gateway reader deadline must fit the existing 2940-second replacement budget",
      );
    }
  };

  return {
    startupSettled,
    getTailscaleIngressEndpoint: gatewayKernel.transportBridge.getTailscaleIngressEndpoint,
    prepareReader: (request, assertCurrent) => {
      assertCurrent();
      assertReaderTarget(request);
      if (!opts.hostLifecycle?.retireWriter || !opts.hostLifecycle.externalRestart?.retireReader) {
        throw new Error("Gateway host cannot retire its native writer heartbeat");
      }
      if (readerPromise) {
        if (!isGatewayReadAdmissionAvailable()) {
          throw new Error("Gateway reader replacement deadline expired");
        }
        if (readerRequest?.expiresAtMs !== request.expiresAtMs) {
          throw new Error("Gateway reader deadline is already fixed");
        }
        return readerPromise;
      }
      if (closePromise) {
        throw new Error("Gateway close already owns this generation");
      }
      readerRequest = structuredClone(request);
      const deadline = performance.now() + request.expiresAtMs - Date.now();
      const assertReaderCurrent = () => {
        assertCurrent();
        if (Date.now() >= request.expiresAtMs || performance.now() >= deadline) {
          throw new Error("Gateway reader replacement deadline expired");
        }
      };
      retireGatewayWriterAdmission(request.expiresAtMs, deadline);
      readerTimer = setTimeout(
        () => {
          retireGatewayReaderAdmission();
          try {
            opts.hostLifecycle!.externalRestart!.retireReader!();
          } catch (error) {
            log.error(formatErrorMessage(error));
          }
        },
        Math.max(
          0,
          Math.ceil(Math.min(request.expiresAtMs - Date.now(), deadline - performance.now())),
        ),
      );
      readerTimer.unref?.();
      readerPromise = Promise.resolve().then(() =>
        sdkResourceHost.run(async (): Promise<GatewayReaderReceipt> => {
          await runWithGatewayWriterRetirementCleanup(async () => {
            const closeOptions = {
              reason: "gateway irreversible reader retirement",
              restartExpectedMs: 0,
              retainReaderTransport: true as const,
            };
            const prelude = gatewayKernel.beginClosePrelude(closeOptions);
            releasePostReadyWork();
            await prelude;
            const close = await prepareClose(closeOptions);
            await runGatewayCloseSteps({
              owner: gatewayKernel,
              close,
              retainReaderTransport: true,
              disposeTerminalSessions: () => terminalSessions.disposeAll(),
              runStopHooks: () =>
                shutdownRuntime.runGlobalGatewayStopSafely({
                  registry: gatewayKernel.pluginRuntime.registry,
                  event: { reason: closeOptions.reason },
                  ctx: { port },
                  onError: (error) => {
                    throw error;
                  },
                }),
              onError: (message) => log.error(message),
            });
            assertReaderCurrent();
            await opts.hostLifecycle!.retireWriter!();
            assertReaderCurrent();
          });
          publishGatewayReaderAdmission(request.expiresAtMs, deadline);
          return {
            version: 1,
            status: "reader-ready",
            pid: process.pid,
            processInstanceId: getGatewayProcessInstanceId(),
            bootId: gatewayKernel.bootId,
            frozenSourceGeneration: randomUUID(),
            retiredAtMs: Date.now(),
            expiresAtMs: request.expiresAtMs,
          };
        }),
      );
      return readerPromise;
    },
    close: (optsLocal) => {
      if (!closePromise) {
        closePromise = sdkResourceHost
          .run(async () => {
            clearTimeout(readerTimer);
            if (readerPromise) {
              const retired = await readerPromise.then(
                () => true,
                () => false,
              );
              retireGatewayReaderAdmission();
              if (retired) {
                gatewayKernel.retireFrozenReaderContext();
                await gatewayKernel.finishReaderTransport();
                return;
              }
            }
            const closeNative = async () => {
              const preparedClose = prepareClose(optsLocal);
              releasePostReadyWork();
              const close = await preparedClose;
              await runGatewayCloseSteps({
                owner: gatewayKernel,
                close,
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
              if (readerPromise) {
                gatewayKernel.retireFrozenReaderContext();
              }
            };
            if (readerPromise) {
              await runWithGatewayWriterRetirementCleanup(closeNative);
            } else {
              await closeNative();
            }
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
