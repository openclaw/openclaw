import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  type SessionPermissionMode,
  SessionPermissionModeSchema,
} from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  type WorkerConnectParams,
  type WorkerConnectRequestFrame,
  WorkerConnectRequestFrameSchema,
  type WorkerTranscriptMessage,
  WorkerTranscriptMessageSchema,
  type WorkerTranscriptCommitParams,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceModelRef,
  WorkerInferenceOptions,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  WorkerInferenceModelRefSchema,
  WorkerInferenceOptionsSchema,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { LoopGuardRuntimeConfig } from "../agents/tool-loop-detection-config.js";
import { isWorkerToolName, type WorkerToolAuthority } from "./tool-authority.js";
import { isWorkerTranscriptMessageFrameSafe } from "./transcript-message.js";
import {
  parseWorkerConnectionEndpoint,
  type WorkerConnectionEndpoint,
} from "./worker-connection-endpoint.js";

const LAUNCH_VERSION = 4;

export type WorkerBrowserLaunchDescriptor = {
  cdpUrl: string;
  launcherPath: string;
};

type WorkerLaunchPermissionContext =
  | { permissionMode: SessionPermissionMode; workerContainmentRoot: string }
  | { permissionMode?: never; workerContainmentRoot?: never };

type WorkerLaunchAssignment = WorkerLaunchPermissionContext & {
  /** Host placement namespace used for worker-local policy, hooks, and audit attribution. */
  agentId: string;
  operationalRunInstance: OperationalRunInstanceRef;
  /** Opaque host-signed runtime envelope; worker code never parses private identity. */
  agentRuntimeIdentityToken: string;
  runId: string;
  turnId: string;
  prompt: string;
  suppressPromptTranscript: boolean;
  workspaceDir: string;
  modelRef: WorkerInferenceModelRef;
  inferenceOptions: WorkerInferenceOptions;
  systemPrompt?: string;
  initialMessages: WorkerTranscriptMessage[];
  transcript: {
    baseLeafId: WorkerTranscriptCommitParams["baseLeafId"];
    nextSeq: number;
  };
  liveEvents: {
    ackedSeq: number;
    nextSeq: number;
  };
  toolAuthority: WorkerToolAuthority;
  browser?: WorkerBrowserLaunchDescriptor;
  /**
   * Operator-resolved runLoop guard state for the worker session, serialized
   * by the gateway after resolving `tools.loopDetection` (global + per-agent
   * overrides, `enabled: false` kill switch). The worker sandbox runs with a
   * fixed minimal config, so this carries the effective guards across the
   * process boundary.
   *
   * Wire semantics after JSON serialization:
   * - Omitted: guards off (pre-guard behavior). The guards are opt-in: the
   *   gateway only emits the field when the operator configured a
   *   `tools.loopDetection` block, and only toward bundles that advertise the
   *   `worker-loop-guard-v1` protocol feature; older bundles reject unknown
   *   launch fields and keep their pre-guard loop until reprovisioned.
   * - `{}` (empty object): all guards explicitly disabled (`enabled: false`).
   * - Partial objects: missing keys mean that specific guard is disabled.
   */
  loopGuardConfig?: LoopGuardRuntimeConfig;
};

type WorkerLaunchAdmission = Omit<WorkerConnectParams["admission"], "runId"> & {
  sessionId: string;
};

export type WorkerLaunchPlan = {
  version: 4;
  admission: WorkerLaunchAdmission;
  assignment: WorkerLaunchAssignment;
};

export type WorkerLaunchDescriptor = WorkerLaunchPlan & {
  connectionEndpoint: WorkerConnectionEndpoint;
};

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH
  );
}

function isSafeSequence(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= minimum;
}

function isAbsoluteHostPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isInferenceOptions(value: unknown): value is WorkerInferenceOptions {
  return Value.Check(WorkerInferenceOptionsSchema, value);
}

function parseToolAuthority(value: unknown): WorkerToolAuthority | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["allowedToolNames"]) ||
    !Array.isArray(value.allowedToolNames) ||
    !value.allowedToolNames.every(isWorkerToolName) ||
    new Set(value.allowedToolNames).size !== value.allowedToolNames.length
  ) {
    return undefined;
  }
  return { allowedToolNames: [...value.allowedToolNames] };
}

function parseBrowserLaunchDescriptor(value: unknown): WorkerBrowserLaunchDescriptor | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["cdpUrl", "launcherPath"]) ||
    typeof value.cdpUrl !== "string" ||
    typeof value.launcherPath !== "string" ||
    !isAbsoluteHostPath(value.launcherPath)
  ) {
    return undefined;
  }
  let cdpUrl: URL;
  try {
    cdpUrl = new URL(value.cdpUrl);
  } catch {
    return undefined;
  }
  const port = Number(cdpUrl.port);
  if (
    cdpUrl.protocol !== "http:" ||
    cdpUrl.hostname !== "127.0.0.1" ||
    cdpUrl.username !== "" ||
    cdpUrl.password !== "" ||
    cdpUrl.port === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    cdpUrl.pathname !== "/" ||
    cdpUrl.search !== "" ||
    cdpUrl.hash !== ""
  ) {
    return undefined;
  }
  return {
    cdpUrl: value.cdpUrl,
    launcherPath: value.launcherPath,
  };
}

function parseLoopGuardConfig(value: unknown): LoopGuardRuntimeConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = ["maxTurns", "maxConsecutiveErrorBatches", "maxIdleRepeatCalls"] as const;
  // Accept any subset of the guard keys: JSON serialization drops `undefined`
  // values, so a fully-disabled state arrives as `{}` and a partially
  // overridden state arrives with only its set keys. Missing/null keys mean
  // that specific guard is disabled. Unknown keys are still rejected. The
  // wire contract rejects zero and negative values, matching the public
  // config schema (`z.number().int().positive()`): a `maxTurns: 0` would
  // otherwise silently terminate the loop before the first provider request.
  if (!hasExactKeys(value, [], [...keys])) {
    return undefined;
  }
  const parsed: LoopGuardRuntimeConfig = {
    maxTurns: undefined,
    maxConsecutiveErrorBatches: undefined,
    maxIdleRepeatCalls: undefined,
  };
  for (const key of keys) {
    const entry = value[key];
    if (entry === undefined || entry === null) {
      continue;
    }
    if (!(Number.isSafeInteger(entry) && typeof entry === "number" && entry >= 1)) {
      return undefined;
    }
    parsed[key] = entry;
  }
  return parsed;
}

function parseAssignment(value: unknown): WorkerLaunchAssignment | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "agentId",
        "runId",
        "operationalRunInstance",
        "agentRuntimeIdentityToken",
        "turnId",
        "prompt",
        "suppressPromptTranscript",
        "workspaceDir",
        "modelRef",
        "inferenceOptions",
        "initialMessages",
        "transcript",
        "liveEvents",
        "toolAuthority",
      ],
      ["systemPrompt", "browser", "permissionMode", "workerContainmentRoot", "loopGuardConfig"],
    )
  ) {
    return undefined;
  }
  const hasPermissionMode = Object.hasOwn(value, "permissionMode");
  const hasContainmentRoot = Object.hasOwn(value, "workerContainmentRoot");
  if (
    hasPermissionMode !== hasContainmentRoot ||
    (hasPermissionMode &&
      (!Value.Check(SessionPermissionModeSchema, value.permissionMode) ||
        typeof value.workerContainmentRoot !== "string" ||
        !isIdentifier(value.workerContainmentRoot) ||
        !isAbsoluteHostPath(value.workerContainmentRoot)))
  ) {
    return undefined;
  }
  if (
    !isIdentifier(value.agentId) ||
    !isIdentifier(value.runId) ||
    !isRecord(value.operationalRunInstance) ||
    !isIdentifier(value.operationalRunInstance.instanceId) ||
    value.operationalRunInstance.runId !== value.runId ||
    typeof value.agentRuntimeIdentityToken !== "string" ||
    value.agentRuntimeIdentityToken.length < 1 ||
    value.agentRuntimeIdentityToken.length > 16_384 ||
    !isIdentifier(value.turnId) ||
    typeof value.prompt !== "string" ||
    typeof value.suppressPromptTranscript !== "boolean" ||
    !isIdentifier(value.workspaceDir) ||
    !isAbsoluteHostPath(value.workspaceDir) ||
    (value.systemPrompt !== undefined && typeof value.systemPrompt !== "string") ||
    !Array.isArray(value.initialMessages) ||
    value.initialMessages.length > WORKER_INFERENCE_MAX_CONTEXT_MESSAGES ||
    !value.initialMessages.every((message) => Value.Check(WorkerTranscriptMessageSchema, message))
  ) {
    return undefined;
  }
  const toolAuthority = parseToolAuthority(value.toolAuthority);
  if (!toolAuthority) {
    return undefined;
  }
  const browser =
    value.browser === undefined ? undefined : parseBrowserLaunchDescriptor(value.browser);
  if (value.browser !== undefined && !browser) {
    return undefined;
  }
  const loopGuardConfig = parseLoopGuardConfig(value.loopGuardConfig);
  if (value.loopGuardConfig !== undefined && loopGuardConfig === undefined) {
    return undefined;
  }
  if (
    !Value.Check(WorkerInferenceModelRefSchema, value.modelRef) ||
    !isInferenceOptions(value.inferenceOptions)
  ) {
    return undefined;
  }
  if (
    !isRecord(value.transcript) ||
    !hasExactKeys(value.transcript, ["baseLeafId", "nextSeq"]) ||
    (value.transcript.baseLeafId !== null && !isIdentifier(value.transcript.baseLeafId)) ||
    !isSafeSequence(value.transcript.nextSeq, 1)
  ) {
    return undefined;
  }
  if (
    !isRecord(value.liveEvents) ||
    !hasExactKeys(value.liveEvents, ["ackedSeq", "nextSeq"]) ||
    !isSafeSequence(value.liveEvents.ackedSeq, 0) ||
    !isSafeSequence(value.liveEvents.nextSeq, 1) ||
    value.liveEvents.nextSeq !== value.liveEvents.ackedSeq + 1
  ) {
    return undefined;
  }
  return {
    ...value,
    operationalRunInstance: Object.freeze({
      instanceId: value.operationalRunInstance.instanceId,
      runId: value.runId,
    }),
    toolAuthority,
    ...(browser ? { browser } : {}),
    ...(loopGuardConfig === undefined ? {} : { loopGuardConfig }),
  } as WorkerLaunchAssignment;
}

export function buildWorkerConnectParams(
  descriptor: Pick<WorkerLaunchPlan, "admission" | "assignment">,
): WorkerConnectParams {
  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: GATEWAY_CLIENT_IDS.WORKER,
      version: descriptor.admission.handshake.openclawVersion,
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.WORKER,
    },
    role: "worker",
    admission: {
      ...descriptor.admission,
      runId: descriptor.assignment.runId,
    },
  };
}

function validateWorkerLaunchPlan(candidate: WorkerLaunchPlan): WorkerLaunchPlan {
  const frame: WorkerConnectRequestFrame = {
    type: "req",
    id: "launch-validation",
    method: "connect",
    params: buildWorkerConnectParams(candidate),
  };
  if (
    !Value.Check(WorkerConnectRequestFrameSchema, frame) ||
    candidate.admission.sessionId === null ||
    candidate.admission.ownerEpoch < 1 ||
    !isWorkerTranscriptMessageFrameSafe({
      role: "user",
      content: [{ type: "text", text: candidate.assignment.prompt }],
      timestamp: Number.MAX_SAFE_INTEGER,
    })
  ) {
    throw new Error("invalid worker launch descriptor");
  }
  return candidate;
}

export function parseWorkerLaunchPlan(value: unknown): WorkerLaunchPlan {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "admission", "assignment"]) ||
    value.version !== LAUNCH_VERSION
  ) {
    throw new Error("invalid worker launch descriptor");
  }
  const assignment = parseAssignment(value.assignment);
  if (!assignment || !isRecord(value.admission)) {
    throw new Error("invalid worker launch descriptor");
  }
  return validateWorkerLaunchPlan({
    version: LAUNCH_VERSION,
    admission: value.admission as WorkerLaunchAdmission,
    assignment,
  });
}

export function completeWorkerLaunchDescriptor(
  plan: WorkerLaunchPlan,
  connectionEndpoint: WorkerConnectionEndpoint,
): WorkerLaunchDescriptor {
  const parsedPlan = parseWorkerLaunchPlan(plan);
  const parsedEndpoint = parseWorkerConnectionEndpoint(connectionEndpoint);
  if (!parsedEndpoint) {
    throw new Error("invalid worker launch descriptor");
  }
  return { ...parsedPlan, connectionEndpoint: parsedEndpoint };
}

export function parseWorkerLaunchDescriptor(value: unknown): WorkerLaunchDescriptor {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "connectionEndpoint", "admission", "assignment"])
  ) {
    throw new Error("invalid worker launch descriptor");
  }
  return completeWorkerLaunchDescriptor(
    {
      version: value.version as 4,
      admission: value.admission as WorkerLaunchAdmission,
      assignment: value.assignment as WorkerLaunchAssignment,
    },
    value.connectionEndpoint as WorkerConnectionEndpoint,
  );
}
