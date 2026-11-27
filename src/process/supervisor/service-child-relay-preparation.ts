import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { prepareChildRuntimeFailure } from "../../infra/child-runtime-viability.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import type { NodeWorkerCleanupBinding } from "../../node-host/node-worker-launch-receipt.js";
import { ServiceChildLaunchNotInitiatedError } from "../spawn-broker/relay-integration.js";
import type { SpawnInitiation } from "../spawn-initiation.js";
import { prepareSecretInputStdio, type SpawnStdioEntry } from "../spawn-secret-input.js";
import { createManagedChildStdin } from "./adapters/child-stdin.js";
import { toStringEnv } from "./adapters/env.js";
import {
  getInheritedNativeProcessOwner,
  getInheritedProcessLineageFds,
} from "./inherited-process-lineage.js";
import { assertProcessGroupControl } from "./service-child-group-ownership.js";
import {
  supportsNodeWorkerProcessOwner,
  sendServiceChildMessage,
  type ServiceChildControlPayload,
  type ServiceChildStart,
} from "./service-child-protocol.js";
import { joinStartupFailureCleanup } from "./service-child-relay-retirement.js";
import { reserveStdioEntry } from "./service-child-stdio.js";
import type {
  ProcessAdapterConstruction,
  ProcessRelease,
  ReleasedProcess,
  SpawnProcessAdapter,
  SpawnSecretInput,
} from "./types.js";

declare const WORKER_DEPLOY_BUILD: boolean;

export type ServiceChildRelayParams = ProcessAdapterConstruction & {
  command: string;
  args: string[];
  argv0?: string;
  cwd?: string;
  stdinMode: "inherit" | "pipe-open" | "pipe-closed";
  input?: string;
  prepareInput?: () => void | Promise<void>;
  prepareTargetSpawn?: () => void | Promise<void>;
  secretInput?: SpawnSecretInput;
  stderrDestination?: Writable;
  stdoutConsumption?: "awaited";
  terminateOnHostLoss?: true;
  oomScoreWrapperSelected: boolean;
  onWorkerMessage?: (message: unknown) => void;
  windowsShellCommand?: string;
  /** Hand off descendants after root exit; ignored where custody cannot be handed off. */
  releaseOnRootExit?: true;
  retainNativeCustody?: true;
} & (
    | {
        ownedWorker: true;
        env: NodeJS.ProcessEnv;
        cleanupBinding: NodeWorkerCleanupBinding;
        nativeProcessOwnerSupported?: true;
      }
    | { ownedWorker?: never; env?: NodeJS.ProcessEnv; cleanupBinding?: never }
  );

export type ServiceChildRelayAdapter = SpawnProcessAdapter<NodeJS.Signals | null> & {
  treeOwnership?: "linux-subreaper";
  waitForExtinction: () => Promise<ProcessRelease | void>;
  /** Present when the owner can hand off a running root; resolves undefined if cancellation won. */
  release?: () => Promise<ReleasedProcess[] | undefined>;
  confirmExtinction: () => boolean;
  openStartGate?: () => Promise<void>;
  closeStartGate?: () => void;
} & Required<Pick<SpawnProcessAdapter<NodeJS.Signals | null>, "onExit" | "onError">>;

/** Transport and target launches share the caller's current synchronous policy. */
export function assertServiceChildSpawn(
  params: ServiceChildRelayParams,
  onAbort?: () => void,
): void {
  if (params.abortSignal?.aborted) {
    onAbort?.();
    throw new Error("service child construction aborted");
  }
  params.assertCurrent?.();
  params.beforeSpawn?.();
}

/** Join startup and private input without replacing admission failure with pipe errors. */
export function startServiceChildRelayInput(options: {
  params: ServiceChildRelayParams;
  preparation: ReturnType<typeof prepareServiceChildRelay>;
  child: ChildProcess;
  start: ServiceChildStart;
  startup: Promise<void>;
  constructionAbort: Promise<never>;
  cleanup: Promise<void>;
  onConstructionAbort: () => void;
  getStartupAcknowledgement: () => Promise<void> | undefined;
  getWaitError: () => Error | undefined;
  hasCommand: () => boolean;
  retire: () => void;
  sendControl: (payload: ServiceChildControlPayload) => Promise<void>;
  onControlError: (error: unknown) => void;
  onInputError: (error: Error) => void;
}) {
  const { params, child } = options;
  const stdin = createManagedChildStdin(
    child.stdin,
    params.terminateOnHostLoss
      ? () => {
          void options
            .sendControl({ type: "stdin-end" })
            .then(() => child.stdin?.end(), options.onControlError);
        }
      : undefined,
    params.terminateOnHostLoss ? options.onInputError : undefined,
  );
  params.abortSignal?.addEventListener("abort", options.onConstructionAbort, { once: true });
  const ready = (async () => {
    using delivery = options.preparation.transferSecretInput();
    try {
      assertServiceChildSpawn(params, options.onConstructionAbort);
      await Promise.race([
        sendServiceChildMessage(child, options.start),
        options.constructionAbort,
      ]);
      params.assertCurrent?.();
      const [startupResult, secretDeliveryResult] = await Promise.allSettled([
        options.startup,
        delivery?.deliverTo(child, { abortSignal: params.abortSignal }),
      ]);
      if (startupResult.status === "rejected") {
        throw await joinStartupFailureCleanup(
          startupResult.reason,
          options.getStartupAcknowledgement(),
          options.cleanup,
        );
      }
      if (secretDeliveryResult.status === "rejected") {
        throw secretDeliveryResult.reason;
      }
      if (params.input !== undefined && params.prepareInput) {
        await params.prepareInput();
      }
      const waitError = options.getWaitError();
      if (params.abortSignal?.aborted || waitError) {
        throw waitError ?? new Error("service child construction aborted");
      }
      params.assertCurrent?.();
      if (params.input !== undefined) {
        stdin?.write(params.input);
        stdin?.end();
      } else if (params.stdinMode === "pipe-closed") {
        stdin?.end();
      }
    } catch (error) {
      options.retire();
      throw (await prepareChildRuntimeFailure({ error, started: options.hasCommand() })) ?? error;
    } finally {
      params.abortSignal?.removeEventListener("abort", options.onConstructionAbort);
    }
  })();
  return { stdin, ready };
}

/** Prepare transport facts; the host revalidates authority immediately before spawning. */
export function prepareServiceChildRelay(params: ServiceChildRelayParams) {
  const nativeProcessOwner =
    getInheritedNativeProcessOwner() ??
    ((process.platform === "linux" || process.platform === "darwin") &&
    (typeof WORKER_DEPLOY_BUILD !== "boolean" || !WORKER_DEPLOY_BUILD)
      ? resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor").href
      : undefined);
  const useNativeProcessOwner =
    nativeProcessOwner !== undefined &&
    (!params.ownedWorker || params.nativeProcessOwnerSupported === true);
  const useLinuxSubreaper = process.platform === "linux" && useNativeProcessOwner;
  const retainNativeCustody = useLinuxSubreaper && params.retainNativeCustody === true;
  if (!useLinuxSubreaper) {
    assertProcessGroupControl();
  }
  const useWindowsJobAnchor =
    process.platform === "win32" && params.windowsShellCommand !== undefined;
  if (params.ownedWorker && !supportsNodeWorkerProcessOwner()) {
    throw new Error("Owned worker relay requires Linux or macOS");
  }
  if (useWindowsJobAnchor && params.stdoutConsumption === "awaited") {
    throw new Error("Windows Job output does not support awaited stdout consumption");
  }
  const stdio: SpawnStdioEntry[] = useWindowsJobAnchor
    ? ["ignore", "ignore", "ignore"]
    : [params.stdinMode === "inherit" ? "inherit" : "pipe", "pipe", "pipe"];
  const secretDelivery = prepareSecretInputStdio(
    stdio,
    useWindowsJobAnchor ? undefined : params.secretInput,
  );
  let deliveryTransferred = false;
  const deliveryOwner = {
    transferSecretInput() {
      deliveryTransferred = true;
      return secretDelivery;
    },
    [Symbol.dispose]() {
      if (!deliveryTransferred) {
        secretDelivery?.[Symbol.dispose]();
      }
    },
  };
  try {
    const controlFd = useWindowsJobAnchor ? undefined : reserveStdioEntry(stdio, "pipe");
    const lineageFd = useWindowsJobAnchor ? undefined : reserveStdioEntry(stdio, "pipe");
    const parentLineageFds = useWindowsJobAnchor
      ? []
      : getInheritedProcessLineageFds().map((fd) => reserveStdioEntry(stdio, fd));
    reserveStdioEntry(stdio, "ipc");
    return {
      // Enclosing worker lineage would stay held by survivors; keep strict cleanup there.
      releaseOnRootExit:
        params.releaseOnRootExit === true &&
        !params.ownedWorker &&
        !useWindowsJobAnchor &&
        parentLineageFds.length === 0,
      useWindowsJobAnchor,
      useLinuxSubreaper,
      retainNativeCustody,
      nativeProcessOwner: useNativeProcessOwner ? nativeProcessOwner : undefined,
      controlFd,
      lineageFd,
      ownership: params.ownedWorker
        ? {
            ownedWorker: true as const,
            cleanupBinding: params.cleanupBinding,
            parentLineageFds: [lineageFd!, ...parentLineageFds],
          }
        : useLinuxSubreaper
          ? { parentLineageFds: [lineageFd!, ...parentLineageFds] }
          : { lineageFd, parentLineageFds },
      spawn: {
        executionIntent: params.executionIntent,
        workerUrl:
          useLinuxSubreaper && !retainNativeCustody
            ? new URL(nativeProcessOwner!)
            : resolveRuntimeProcessEntrypointUrl(
                useWindowsJobAnchor ? "serviceChildWindowsJobAnchor" : "serviceChildRelay",
              ),
        env: params.ownedWorker ? params.env : process.env,
        ...(useLinuxSubreaper ? { nativeProcessOwner } : {}),
        detached:
          useWindowsJobAnchor ||
          useLinuxSubreaper ||
          params.ownedWorker === true ||
          parentLineageFds.length > 0,
        stdio,
      },
      ...deliveryOwner,
    };
  } catch (error) {
    deliveryOwner[Symbol.dispose]();
    throw error;
  }
}

/** Build the anchor's first frame; prepare frames wait for a separate launch grant. */
export function createServiceChildStart(
  params: ServiceChildRelayParams,
  preparation: Pick<
    ReturnType<typeof prepareServiceChildRelay>,
    | "controlFd"
    | "ownership"
    | "useLinuxSubreaper"
    | "nativeProcessOwner"
    | "releaseOnRootExit"
    | "retainNativeCustody"
  >,
  generation: string,
  acknowledgeClosing: boolean,
): ServiceChildStart {
  return {
    type: params.initiateSpawn || params.prepareTargetSpawn ? "prepare" : "start",
    executionIntent: params.executionIntent,
    executionScopeKey: params.executionScopeKey,
    generation,
    command: params.command,
    args: params.args,
    argv0: params.argv0,
    cwd: params.cwd,
    env: toStringEnv(params.env ?? process.env),
    stdinMode: params.stdinMode,
    secretFd: params.secretInput?.fd,
    terminateOnHostLoss: params.terminateOnHostLoss,
    controlFd: preparation.controlFd,
    ...preparation.ownership,
    treeOwnership: preparation.useLinuxSubreaper ? "linux-subreaper" : undefined,
    ...(preparation.retainNativeCustody ? { retainNativeCustody: true as const } : {}),
    nativeProcessOwner: preparation.nativeProcessOwner,
    ...(acknowledgeClosing ? { acknowledgeClosing: true as const } : {}),
    ...(preparation.releaseOnRootExit ? { releaseOnRootExit: true as const } : {}),
    windowsShellCommand: params.windowsShellCommand,
  };
}

/** Grant a prepared anchor its launch frame after final caller policy checks. */
export function grantServiceChildLaunch(options: {
  params: ServiceChildRelayParams;
  isStarting: () => boolean;
  sendControlMessage: (
    payload: ServiceChildControlPayload,
    initiate?: SpawnInitiation,
  ) => Promise<void>;
  onError: (error: unknown) => void;
  onRefused: (cause: unknown) => void;
}): void {
  const { params, isStarting, sendControlMessage } = options;
  void (async () => {
    try {
      await params.prepareTargetSpawn?.();
      assertServiceChildSpawn(params);
    } catch (error) {
      throw new ServiceChildLaunchNotInitiatedError(error);
    }
    if (!isStarting()) {
      return;
    }
    await sendControlMessage({ type: "launch" }, params.initiateSpawn);
  })().catch((error: unknown) => {
    if (!(error instanceof ServiceChildLaunchNotInitiatedError) || !isStarting()) {
      options.onError(error);
      return;
    }
    options.onRefused(error.cause);
    void sendControlMessage({ type: "cancel", signal: "SIGKILL" }).catch(options.onError);
  });
}
