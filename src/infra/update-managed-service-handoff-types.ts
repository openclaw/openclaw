import type { TriageFailureContext } from "../commands/triage-prompt.js";
import type { RespawnSupervisor } from "./supervisor-markers.js";
import type { UpdateChannel } from "./update-channels.js";
import type { DevUpdateTarget } from "./update-dev-target.js";
import type { UpdateRequester } from "./update-requester-authority.js";
import type {
  ForegroundUpdateOrigin,
  UpdateRestartSentinelMeta,
} from "./update-restart-sentinel-payload.js";

export type ManagedServiceUpdateHandoffParams = {
  runId?: string;
  beforePark?: () => Promise<void>;
  /** Local original admission; never serialized to the detached helper. */
  requesterAuthority?: Readonly<{ assertCurrent: () => void; signal?: AbortSignal }>;
  root: string;
  timeoutMs?: number;
  recoveryTimeoutMs?: number;
  restartDrainTimeoutMs: number;
  restartDelayMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  acceptCapabilities?: boolean;
  reapplyLocalOverrides?: boolean;
  meta: UpdateRestartSentinelMeta;
  requester?: UpdateRequester;
  handoffId?: string;
  supervisor?: RespawnSupervisor | null;
  foregroundOrigin?: ForegroundUpdateOrigin;
  env?: NodeJS.ProcessEnv;
  devTarget?: DevUpdateTarget;
  execPath?: string;
  argv1?: string;
  parentPid?: number;
  invocationCwd?: string;
  action?: {
    kind: "triage";
    failure: TriageFailureContext;
    entrypoint: string;
    nodeRunner: string;
  };
};

export type ManagedServiceUpdateHandoffResult = {
  pid?: number;
  command: string;
  logPath: string;
} & (
  | { status: "started"; handoffId: string; installRoot: string }
  | { status: "joined"; handoffId?: string }
);
