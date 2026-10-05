import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import type {
  SessionsProcessesListResult,
  SessionsProcessesStopResult,
} from "../../packages/gateway-protocol/src/schema/session-processes.js";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  boundedWorkerError,
  boundedWorkerErrorWithCode,
} from "../gateway/worker-environments/worker-error.js";
import {
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
  NODE_WORKER_DESKTOP_LAUNCH_COMMAND,
  NODE_WORKER_DESKTOP_STREAM_COMMAND,
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_PROCESSES_COMMAND,
  NODE_WORKER_PORTAL_STREAM_COMMAND,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
  NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
} from "../infra/node-commands.js";
import { logWarn } from "../logger.js";
import {
  NODE_WORKER_BUNDLE_INSTALL_ERROR_CODE,
  NodeWorkerBundleInstallError,
  parseNodeWorkerBundleInstallInput,
  type NodeWorkerBundleInstallResult,
} from "../worker/node-bundle-install-protocol.js";
import {
  parseNodeWorkerCancelInput,
  parseNodeWorkerEnvironmentStopInput,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerLookupInput,
  type NodeWorkerSupervisorReceipt,
} from "../worker/node-supervisor-protocol.js";
import {
  parseNodeWorkerPreparedWorkspaceInput,
  type NodeWorkerPreparedWorkspaceResult,
} from "../worker/node-workspace-prepared-protocol.js";
import {
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
import {
  parseNodeWorkerWorkspaceRetainInput,
  type NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import {
  NODE_WORKSPACE_TRANSFER_ERROR_CODE,
  NodeWorkerWorkspaceTransferError,
} from "../worker/node-workspace-transfer-protocol.js";
import {
  parseWorkerConnectionEndpoint,
  type WorkerConnectionEndpoint,
} from "../worker/worker-connection-endpoint.js";
import { parseNodeWorkerProcessInput } from "../worker/worker-process-observation.js";
import { invokeNodeWorkerDesktopLaunch } from "./desktop-launch-command.js";
import { invokeNodeWorkerDesktopStream } from "./desktop-stream-command.js";
import type { NodeWorkerBundleInstallerControl } from "./node-worker-bundle-installer.js";
import { NodeWorkerCapacityExhaustedError } from "./node-worker-capacity.js";
import {
  projectNodeWorkerSupervisorReceipt,
  type NodeWorkerSupervisorControl,
} from "./node-worker-supervisor-contract.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
import { invokeNodeWorkerPortalStream } from "./portal-stream-command.js";

const WORKSPACE_TRANSFER_DIAGNOSTIC_MAX_CHARS = 1_024;
const WORKSPACE_DIAGNOSTIC_MAX_CHARS = 500;

type NodeWorkerSupervisorCommandPayload =
  | SessionsProcessesListResult
  | SessionsProcessesStopResult
  | NodeWorkerBundleInstallResult
  | NodeWorkerSupervisorReceipt
  | NodeWorkerWorkspaceExecResult
  | NodeWorkerPreparedWorkspaceResult
  | NodeWorkerWorkspaceRetainResult
  | { status: "ready" }
  | null;

function workspaceTransferDiagnostic(error: NodeWorkerWorkspaceTransferError): string {
  if (!error.operation || !error.stage) {
    return error.message;
  }
  const prefix = `workspace-transfer-failed: operation=${error.operation} stage=${error.stage}: `;
  return `${prefix}${boundedWorkerErrorWithCode(
    error.cause ?? error,
    WORKSPACE_TRANSFER_DIAGNOSTIC_MAX_CHARS - prefix.length,
  )}`;
}

function resolveWorkerConnectionEndpoint(params: {
  gatewayUrl?: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
}): WorkerConnectionEndpoint {
  if (!params.gatewayUrl) {
    throw new Error("node worker gateway connection unavailable");
  }
  const endpointUrl = new URL(params.gatewayUrl);
  if (endpointUrl.protocol !== "ws:" && endpointUrl.protocol !== "wss:") {
    throw new Error("node worker gateway connection must use WebSocket transport");
  }
  const basePath = endpointUrl.pathname.replace(/\/$/u, "");
  endpointUrl.pathname = `${basePath}${WORKER_PUBLIC_INGRESS_PATH}`;
  endpointUrl.search = "";
  endpointUrl.hash = "";
  const endpoint = parseWorkerConnectionEndpoint({
    kind: "websocket",
    url: endpointUrl.toString(),
    ...(endpointUrl.protocol === "wss:" && params.gatewayTlsFingerprint
      ? { tlsFingerprint: params.gatewayTlsFingerprint }
      : {}),
    ...(params.gatewayCloudflareAccess ? { cloudflareAccess: params.gatewayCloudflareAccess } : {}),
  });
  if (!endpoint) {
    throw new Error("node worker gateway connection could not form a worker endpoint");
  }
  return endpoint;
}

/** Dispatches the non-advertised worker control contract before public node commands. */
export async function invokeNodeWorkerSupervisorCommand(params: {
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
  supervisor?: NodeWorkerSupervisorControl;
  bundleInstaller?: NodeWorkerBundleInstallerControl;
  workspace?: NodeWorkerWorkspaceRuntime;
  gatewayUrl?: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  signal?: AbortSignal;
}) {
  const { supervisor, bundleInstaller, workspace, paramsJSON, signal } = params;
  const receipt = (value: Awaited<ReturnType<NodeWorkerSupervisorControl["status"]>>) =>
    value ? projectNodeWorkerSupervisorReceipt(value) : null;
  const commands: Record<
    string,
    () => Promise<NodeWorkerSupervisorCommandPayload | undefined> | undefined
  > = {
    [NODE_WORKER_WORKSPACE_PREPARE_COMMAND]: () =>
      workspace?.prepare(parseNodeWorkerPreparedWorkspaceInput(paramsJSON), signal),
    [NODE_WORKER_BUNDLE_INSTALL_COMMAND]: () => {
      if (!bundleInstaller) {
        return undefined;
      }
      if (!params.gatewayUrl) {
        throw new Error("node worker gateway connection unavailable");
      }
      const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 0, 0);
      const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      // The node retains the sent budget even if the Gateway's cancel frame cannot arrive.
      const installSignal = deadline
        ? signal
          ? AbortSignal.any([signal, deadline])
          : deadline
        : signal;
      return bundleInstaller.ensure({
        input: parseNodeWorkerBundleInstallInput(paramsJSON),
        gatewayUrl: params.gatewayUrl,
        ...(params.gatewayTlsFingerprint
          ? { gatewayTlsFingerprint: params.gatewayTlsFingerprint }
          : {}),
        ...(params.gatewayCloudflareAccess
          ? { gatewayCloudflareAccess: params.gatewayCloudflareAccess }
          : {}),
        signal: installSignal,
      });
    },
    [NODE_WORKER_WORKSPACE_EXEC_COMMAND]: () =>
      workspace?.exec(
        parseNodeWorkerWorkspaceExecInput(paramsJSON),
        signal,
        params.gatewayUrl
          ? {
              url: params.gatewayUrl,
              ...(params.gatewayTlsFingerprint
                ? { tlsFingerprint: params.gatewayTlsFingerprint }
                : {}),
              ...(params.gatewayCloudflareAccess
                ? { cloudflareAccess: params.gatewayCloudflareAccess }
                : {}),
            }
          : undefined,
      ),
    [NODE_WORKER_WORKSPACE_RETAIN_COMMAND]: async () => {
      if (!supervisor) {
        return undefined;
      }
      const input = parseNodeWorkerWorkspaceRetainInput(paramsJSON);
      const retained = await supervisor.retainWorkspaces(input, signal);
      let bundles: { deleted: number; hasMore: boolean; generation: number } | undefined;
      if (retained.applied && input.bundleHashes) {
        if (!bundleInstaller?.retain) {
          throw new Error("node worker bundle retention unavailable");
        }
        bundles = await bundleInstaller.retain({
          gatewayNamespace: input.gatewayNamespace,
          bundleHashes: input.bundleHashes,
          ...(input.acknowledgedBundleGeneration !== undefined
            ? { acknowledgedGeneration: input.acknowledgedBundleGeneration }
            : {}),
        });
      }
      const hasMore = retained.hasMore || bundles?.hasMore === true;
      const inspectBundle = bundleInstaller?.inspect?.bind(bundleInstaller);
      if (retained.applied && input.bundleStatusHash && !hasMore && !inspectBundle) {
        throw new Error("node worker bundle status unavailable");
      }
      const bundleStatus =
        retained.applied && input.bundleStatusHash && !hasMore && inspectBundle
          ? await inspectBundle({
              gatewayNamespace: input.gatewayNamespace,
              bundleHash: input.bundleStatusHash,
            })
          : undefined;
      return bundles || bundleStatus
        ? {
            ...retained,
            ...(bundles
              ? { bundleDeleted: bundles.deleted, bundleGeneration: bundles.generation, hasMore }
              : {}),
            ...(bundleStatus ? { bundleStatus } : {}),
          }
        : retained;
    },
    [NODE_WORKER_DESKTOP_STREAM_COMMAND]: () =>
      supervisor && invokeNodeWorkerDesktopStream(params).then(() => null),
    [NODE_WORKER_PORTAL_STREAM_COMMAND]: () =>
      supervisor && invokeNodeWorkerPortalStream(params).then(() => null),
    [NODE_WORKER_DESKTOP_LAUNCH_COMMAND]: () =>
      supervisor && invokeNodeWorkerDesktopLaunch({ paramsJSON, signal }),
    [NODE_WORKER_PROCESSES_COMMAND]: () =>
      supervisor?.observeProcesses(parseNodeWorkerProcessInput(paramsJSON), signal),
    [NODE_WORKER_ENVIRONMENT_STOP_COMMAND]: () =>
      supervisor?.stopEnvironment(parseNodeWorkerEnvironmentStopInput(paramsJSON)).then(() => null),
    [NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND]: () =>
      supervisor
        ?.launch(
          parseNodeWorkerLaunchInput(paramsJSON),
          resolveWorkerConnectionEndpoint(params),
          signal,
        )
        .then(receipt),
    [NODE_WORKER_SUPERVISOR_STATUS_COMMAND]: () => {
      if (!supervisor) {
        return undefined;
      }
      const input = parseNodeWorkerLookupInput(paramsJSON);
      return supervisor
        .status(
          input.launchId,
          ...(input.waitMs === undefined ? [] : [{ waitMs: input.waitMs, signal }]),
        )
        .then(receipt);
    },
    [NODE_WORKER_SUPERVISOR_CANCEL_COMMAND]: () =>
      supervisor?.cancel(parseNodeWorkerCancelInput(paramsJSON)).then(receipt),
  };
  const invoke = Object.hasOwn(commands, params.command) ? commands[params.command] : undefined;
  if (!invoke) {
    return { handled: false as const };
  }
  const workspaceCommand =
    params.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND ||
    params.command === NODE_WORKER_WORKSPACE_PREPARE_COMMAND ||
    params.command === NODE_WORKER_WORKSPACE_RETAIN_COMMAND;
  try {
    const payload = await invoke();
    if (payload === undefined && workspaceCommand) {
      logWarn(
        `node workspace command failed (${params.command}, UNAVAILABLE): node worker runtime unavailable`,
      );
    }
    return payload === undefined
      ? {
          handled: true as const,
          ok: false as const,
          code: "UNAVAILABLE" as const,
          message: "node worker runtime unavailable",
        }
      : { handled: true as const, ok: true as const, payload };
  } catch (error) {
    const invalid = error instanceof Error && error.message.startsWith("INVALID_REQUEST:");
    const bundleInstallFailure = error instanceof NodeWorkerBundleInstallError;
    const capacityFailure = error instanceof NodeWorkerCapacityExhaustedError;
    const transferFailure = error instanceof NodeWorkerWorkspaceTransferError;
    const code = invalid
      ? ("INVALID_REQUEST" as const)
      : bundleInstallFailure
        ? NODE_WORKER_BUNDLE_INSTALL_ERROR_CODE
        : capacityFailure
          ? NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE
          : transferFailure
            ? NODE_WORKSPACE_TRANSFER_ERROR_CODE
            : ("UNAVAILABLE" as const);
    const message = transferFailure
      ? workspaceTransferDiagnostic(error)
      : workspaceCommand
        ? boundedWorkerErrorWithCode(error, WORKSPACE_DIAGNOSTIC_MAX_CHARS)
        : invalid || bundleInstallFailure || capacityFailure
          ? error.message
          : "node worker supervisor command failed";
    if (workspaceCommand) {
      logWarn(
        `node workspace command failed (${params.command}, ${code}): ${boundedWorkerError(message, WORKSPACE_DIAGNOSTIC_MAX_CHARS)}`,
      );
    }
    return { handled: true as const, ok: false as const, code, message };
  }
}
