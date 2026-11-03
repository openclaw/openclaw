import { AsyncLocalStorage } from "node:async_hooks";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { PluginsReloadParams } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { hashStableJson } from "../../plugins/installed-plugin-index-hash.js";
import {
  PluginRuntimeApplicationError,
  type PluginLifecycleRuntimeApply,
  type PluginRuntimeApplication,
} from "../../plugins/lifecycle.js";
import { reloadManagedPlugin } from "../../plugins/management-mutations.js";
import { withPluginLifecycleLeaseAsync } from "../../plugins/plugin-lifecycle-lease.js";
import { runWithGatewayDetachedWorkAdmission } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  acceptGatewayDeviceSourceAuthority,
  readGatewayDeviceSourceAuthority,
  retainGatewayDeviceRevocation,
} from "../device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { getPluginReloadOperationOwner } from "../plugin-reload-operation-gateway.js";
import type { AppliedPluginReloadResult } from "../plugin-reload-operation.js";
import { pluginLifecycleError } from "./plugins-lifecycle-error.js";
import { assertPluginMutationAuthority } from "./plugins-mutation-authority.js";
import type { GatewayRequestHandler } from "./types.js";

/** Stage under invocation authority, then transfer accepted work to Gateway custody. */
export async function handleForcedPluginReload(
  request: Parameters<GatewayRequestHandler>[0],
  params: PluginsReloadParams,
): Promise<void> {
  const { context, respond, signal, sessionMutationCommitGuard } = request;
  if (!params.force) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "operationId requires force; ordinary reloads are not operation observers.",
      ),
    );
    return;
  }
  const controller = new AbortController();
  let transferred = false;
  let staged = false;
  let applied: PluginRuntimeApplication | undefined;
  let operator: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
  let releaseDevice: ReturnType<typeof retainGatewayDeviceRevocation>;
  let operationOwnsAuthority = false;
  const sourceCurrent = readGatewayDeviceSourceAuthority(request.hasCurrentClientAuthority);
  const releaseAuthority = () => {
    operator?.release();
    releaseDevice?.();
  };
  const callerAborted = () => controller.abort(signal?.reason);
  const assertCurrent = () => {
    if (transferred) {
      if (sourceCurrent?.() !== true) {
        throw new Error("Accepted plugin mutation source authority is no longer active.");
      }
    } else {
      assertPluginMutationAuthority(request);
    }
    operator?.authority.assertCurrent();
    controller.signal.throwIfAborted();
    if (!transferred) {
      sessionMutationCommitGuard?.();
    }
  };
  signal?.addEventListener("abort", callerAborted, { once: true });
  if (signal?.aborted) {
    callerAborted();
  }
  const ready = createDeferredCore<{
    change: Parameters<PluginLifecycleRuntimeApply>[0];
    context: ReturnType<typeof AsyncLocalStorage.snapshot>;
  }>();
  const begin = createDeferredCore<{
    operationId: string;
    beforeForceDrain: NonNullable<Parameters<PluginLifecycleRuntimeApply>[0]["beforeForceDrain"]>;
  }>();
  let management: ReturnType<typeof reloadManagedPlugin> | undefined;
  try {
    assertCurrent();
    operator = await captureGatewayOperatorRunAuthority({
      ...request,
      client: request.client ?? null,
    });
    assertCurrent();
    releaseDevice = retainGatewayDeviceRevocation(request.hasCurrentClientAuthority);
    if (!sourceCurrent) {
      throw new Error(
        "This caller cannot transfer write authority to a Gateway-owned reload. Use an authenticated Gateway CLI connection.",
      );
    }
    const applyRuntime = context.applyPluginLifecycleChange;
    if (!applyRuntime) {
      throw new Error("Plugin lifecycle changes require a running Gateway.");
    }
    const owner = getPluginReloadOperationOwner(context);
    const requestKey = hashStableJson(params.plugins);
    const observe = params.operationId
      ? await owner.observe(params.operationId, requestKey)
      : undefined;
    assertCurrent();
    if (observe) {
      const result = params.waitForDrain
        ? signal
          ? await racePromiseWithAbortSignal(observe.finished, signal)
          : await observe.finished
        : observe.receipt;
      respond(true, result, undefined);
      return;
    }
    // Detached staging retains its real lifecycle lease through the operation. The
    // caller can cancel only until acceptance; no request scope owns later cleanup.
    management = runWithGatewayDetachedWorkAdmission(
      () =>
        withPluginLifecycleLeaseAsync({ signal: controller.signal, waitMs: 0 }, () =>
          reloadManagedPlugin({
            plugins: params.plugins,
            acknowledgeCapabilities: params.acknowledgeCapabilities,
            waitForDrain: true,
            signal: controller.signal,
            beforePersistentApply: assertCurrent,
            applyRuntime: async (change) => {
              staged = true;
              ready.resolve({ change, context: AsyncLocalStorage.snapshot() });
              const operation = await begin.promise;
              assertCurrent();
              applied = await applyRuntime({
                ...change,
                ...operation,
                waitForDrain: true,
                drainSignal: undefined,
                assertInvokerOwned: () => {
                  assertCurrent();
                  change.assertInvokerOwned?.();
                },
              });
              return applied;
            },
          }),
        ),
      "plugin-reload:staging",
      controller.signal,
    );
    void management.catch((error: unknown) => ready.reject(error));
    const stage = await ready.promise;
    const { change } = stage;
    assertCurrent();
    const managementResult = management;
    // The detached job retains the staged lease admission, not the socket
    // resource owner. Its live source guard still fences every later effect.
    const operation = await stage.context(() =>
      owner.start({
        operationId: params.operationId,
        pluginIds: [...change.pluginIds],
        requestKey,
        signal: controller.signal,
        assertCurrent,
        onAccepted: () => {
          assertCurrent();
          if (!acceptGatewayDeviceSourceAuthority(request.hasCurrentClientAuthority)) {
            throw new Error("Plugin reload source authority could not be accepted by the Gateway.");
          }
          transferred = true;
          assertCurrent();
          signal?.removeEventListener("abort", callerAborted);
        },
        run: async (beforeForceDrain, operationId): Promise<AppliedPluginReloadResult> => {
          begin.resolve({ beforeForceDrain, operationId });
          try {
            const result = await managementResult;
            if (!result.application) {
              throw new Error("Plugin lifecycle did not return a runtime application receipt.");
            }
            const {
              warnings: runtimeWarnings,
              restartRequired = false,
              ...runtime
            } = result.application;
            const warnings = [...new Set(runtimeWarnings ?? [])];
            return {
              ok: true,
              pluginIds: [...runtime.pluginIds],
              restartRequired,
              runtime,
              ...(warnings.length ? { warnings } : {}),
            };
          } catch (error) {
            if (applied && !(error instanceof PluginRuntimeApplicationError)) {
              throw new PluginRuntimeApplicationError(
                formatErrorMessage(error),
                {
                  operationId: applied.operationId,
                  generation: applied.generation,
                  pluginIds: applied.pluginIds,
                  phase: "dispose",
                  committed: true,
                },
                { cause: error },
              );
            }
            throw error;
          }
        },
      }),
    );
    if (transferred) {
      operationOwnsAuthority = true;
      void operation.finished.then(releaseAuthority, releaseAuthority);
    }
    if (!transferred) {
      // A completed operation may appear between initial observation and staging.
      // Retire this unused preparation, never replay its runtime effect.
      begin.reject(new Error("Plugin reload outcome was already recorded."));
      await managementResult.catch(() => {});
    }
    const result = params.waitForDrain
      ? signal
        ? await racePromiseWithAbortSignal(operation.finished, signal)
        : await operation.finished
      : operation.receipt;
    respond(true, result, undefined);
  } catch (error) {
    if (!transferred && staged) {
      begin.reject(error);
      await management?.catch(() => {});
    }
    respond(false, undefined, pluginLifecycleError(error, { entered: staged, signal }));
  } finally {
    signal?.removeEventListener("abort", callerAborted);
    if (!operationOwnsAuthority) {
      releaseAuthority();
    }
  }
}
