import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { z } from "zod";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  type SessionPermissionMode,
  SessionPermissionModeSchema,
} from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  SkillResourceDeliverySchema,
  type SkillResourceDelivery,
} from "../../packages/gateway-protocol/src/schema/skill-resources.js";
import {
  type WorkerConnectParams,
  type WorkerConnectRequestFrame,
  WorkerConnectRequestFrameSchema,
  type WorkerTranscriptMessage,
  WorkerTranscriptMessageSchema,
  WorkerTranscriptUserMessageSchema,
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
import {
  WorkerSkillWorkshopBindingSchema,
  type WorkerSkillWorkshopBinding,
} from "../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import {
  ComputerUseCapabilityDescriptorSchema,
  type ComputerUseCapabilityDescriptor,
} from "../plugins/computer-use-contract.js";
import { hasExactOwnKeys, workerProtocolObject } from "./protocol-record.js";
import { isWorkerToolName, type WorkerToolName } from "./tool-authority.js";
import { isWorkerTranscriptMessageFrameSafe } from "./transcript-message.js";
import {
  parseWorkerConnectionEndpoint,
  type WorkerConnectionEndpoint,
} from "./worker-connection-endpoint.js";

const LAUNCH_VERSION = 4;

type WorkerLaunchPermissionContext =
  | { permissionMode: SessionPermissionMode; workerContainmentRoot: string }
  | { permissionMode?: never; workerContainmentRoot?: never };

export type WorkerBrowserLaunchDescriptor = z.infer<typeof BrowserLaunchSchema>;
export type WorkerComputerLaunchDescriptor = z.infer<typeof ComputerLaunchSchema>;
export type WorkerGitHubLaunchBinding = z.infer<typeof GitHubLaunchSchema>;
type WorkerLaunchAssignment = Omit<
  z.infer<typeof AssignmentSchema>,
  "permissionMode" | "workerContainmentRoot"
> &
  WorkerLaunchPermissionContext;

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

const Identifier = z
  .string()
  .min(1)
  .max(WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH)
  .refine((value) => value.trim() === value);
const Sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const AbsoluteHostPath = z
  .string()
  .refine((value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
// Project preparation admits paths longer than the worker identifier limit.
const WorkspacePath = AbsoluteHostPath.refine(
  (value) => value.trim() === value && value.length <= 4_096 && !value.includes("\0"),
);
const ToolAuthoritySchema = workerProtocolObject({
  allowedToolNames: z
    .custom<WorkerToolName[]>(
      (value) =>
        Array.isArray(value) &&
        value.every(isWorkerToolName) &&
        new Set(value).size === value.length,
    )
    .transform((names) => [...names]),
});
const BrowserLaunchSchema = workerProtocolObject({
  cdpUrl: z.string().refine((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      url.port !== "" &&
      Number(url.port) >= 1 &&
      Number(url.port) <= 65_535 &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  }),
  launcherPath: AbsoluteHostPath,
});
const ComputerLaunchSchema = workerProtocolObject({
  nodeId: Identifier,
  computerUse: z.custom<ComputerUseCapabilityDescriptor>((value) =>
    Value.Check(ComputerUseCapabilityDescriptorSchema, value),
  ),
});
const GitAuthorField = z
  .string()
  .max(256)
  .refine((value) => Boolean(value.trim()) && !/[\0\r\n]/u.test(value));
const GitAuthorSchema = workerProtocolObject({
  name: GitAuthorField.optional(),
  email: GitAuthorField.optional(),
}).refine((value) => Object.values(value).every((entry) => entry !== undefined));
const GitHubLaunchSchema = workerProtocolObject({
  token: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => !/[\s\p{Cc}]/u.test(value)),
  login: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,39}$/u)
    .refine((value) => value.trim() === value),
  branch: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (value) =>
        !/[\s~^:?*[\\]/u.test(value) &&
        !value.includes("\0") &&
        !value.startsWith("-") &&
        !value.includes("..") &&
        !value.includes("@{"),
    ),
  remoteUrl: z
    .string()
    .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u)
    .refine((value) => value.trim() === value)
    .optional(),
  gitAuthor: GitAuthorSchema.optional(),
}).refine((value) => Object.values(value).every((entry) => entry !== undefined));

export function parseWorkerGitHubLaunchBinding(
  value: unknown,
): WorkerGitHubLaunchBinding | undefined {
  const parsed = GitHubLaunchSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const AssignmentSchema = workerProtocolObject({
  skillAuthoring: z
    .custom<WorkerSkillWorkshopBinding>((value) =>
      Value.Check(WorkerSkillWorkshopBindingSchema, value),
    )
    .optional(),
  skillResources: z
    .custom<SkillResourceDelivery>((value) => Value.Check(SkillResourceDeliverySchema, value))
    .optional(),
  agentId: Identifier,
  operationalRunInstance: z.object({ instanceId: Identifier, runId: Identifier }).readonly(),
  // The worker carries this opaque host-signed envelope without parsing private identity.
  agentRuntimeIdentityToken: z.string().min(1).max(16_384),
  runId: Identifier,
  turnId: Identifier,
  prompt: z.custom<string | Extract<WorkerTranscriptMessage, { role: "user" }>["content"]>(
    (value) =>
      typeof value === "string" ||
      Value.Check(WorkerTranscriptUserMessageSchema, {
        role: "user",
        content: value,
        timestamp: 0,
      }),
  ),
  suppressPromptTranscript: z.boolean(),
  workspaceDir: WorkspacePath,
  modelRef: z.custom<WorkerInferenceModelRef>((value) =>
    Value.Check(WorkerInferenceModelRefSchema, value),
  ),
  inferenceOptions: z.custom<WorkerInferenceOptions>((value) =>
    Value.Check(WorkerInferenceOptionsSchema, value),
  ),
  systemPrompt: z.string().optional(),
  initialMessages: z.custom<WorkerTranscriptMessage[]>(
    (value) =>
      Array.isArray(value) &&
      value.length <= WORKER_INFERENCE_MAX_CONTEXT_MESSAGES &&
      value.every((message) => Value.Check(WorkerTranscriptMessageSchema, message)),
  ),
  transcript: workerProtocolObject({ baseLeafId: Identifier.nullable(), nextSeq: Sequence.min(1) }),
  liveEvents: workerProtocolObject({ ackedSeq: Sequence, nextSeq: Sequence.min(1) }).refine(
    (value) => value.nextSeq === value.ackedSeq + 1,
  ),
  toolAuthority: ToolAuthoritySchema,
  browser: BrowserLaunchSchema.optional(),
  computer: ComputerLaunchSchema.optional(),
  github: GitHubLaunchSchema.optional(),
  permissionMode: z
    .custom<SessionPermissionMode>((value) => Value.Check(SessionPermissionModeSchema, value))
    .optional(),
  workerContainmentRoot: WorkspacePath.optional(),
}).refine(
  (value) =>
    value.operationalRunInstance.runId === value.runId &&
    value.toolAuthority.allowedToolNames.includes("computer") === (value.computer !== undefined) &&
    (!Object.hasOwn(value, "github") || value.github !== undefined) &&
    (Object.hasOwn(value, "permissionMode")
      ? value.permissionMode !== undefined && value.workerContainmentRoot !== undefined
      : !Object.hasOwn(value, "workerContainmentRoot")),
);

function parseAssignment(value: unknown): WorkerLaunchAssignment | undefined {
  const parsed = AssignmentSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const { permissionMode, workerContainmentRoot, ...assignment } = parsed.data;
  if (permissionMode !== undefined && workerContainmentRoot !== undefined) {
    return { ...assignment, permissionMode, workerContainmentRoot };
  }
  return assignment;
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
      content:
        typeof candidate.assignment.prompt === "string"
          ? [{ type: "text", text: candidate.assignment.prompt }]
          : candidate.assignment.prompt,
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
    !hasExactOwnKeys(value, ["version", "admission", "assignment"]) ||
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
    !hasExactOwnKeys(value, ["version", "connectionEndpoint", "admission", "assignment"])
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
