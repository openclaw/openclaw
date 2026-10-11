import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronStoredJob } from "../cron/types.js";
import type { AgentDeletionWorkerGuard } from "../state/agent-deletion-worker-contract.js";
import type { ClawAutomationInstallIntent } from "./automation-install-intent.js";
import type { ClawCronInstallUpdate } from "./cron-update-contract.js";
import type { ClawPortableHeartbeat } from "./cron.types.js";
import type { PortableHeartbeatState } from "./portable-heartbeat-state.types.js";
import type { PersistedClawInstall } from "./provenance-types.js";

type PortableHeartbeatSource = { heartbeat: ClawPortableHeartbeat; scratch?: string };
export type PortableHeartbeatMutation = {
  agentId: string;
  storePath: string;
  nowMs: number;
} & (
  | {
      kind: "import";
      plannedJob: CronStoredJob;
      source: PortableHeartbeatSource;
      expected?: PortableHeartbeatState;
      install?: ClawCronInstallUpdate;
      gatewayInstall?: { intent: ClawAutomationInstallIntent; config: OpenClawConfig };
    }
  | {
      kind: "update";
      expected: PortableHeartbeatState;
      plannedJob: CronStoredJob;
      source: PortableHeartbeatSource;
    }
  | { kind: "release"; expected: PortableHeartbeatState }
  | { kind: "rollback"; expected: PortableHeartbeatState; previous: PortableHeartbeatState }
  | { kind: "completeTasks"; jobId: string; sourceScratchDigest: string }
  | {
      kind: "removeRef";
      expected: PortableHeartbeatState;
      deletion: AgentDeletionWorkerGuard;
      expectedInstall: PersistedClawInstall | null;
    }
);

export type PortableHeartbeatMutationResult = {
  state: PortableHeartbeatState;
  installRecord?: PersistedClawInstall;
};
