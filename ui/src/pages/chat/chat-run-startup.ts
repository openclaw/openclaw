import type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";
import type { WorkerEnvironmentStartStatus } from "../../../../packages/gateway-protocol/src/schema/environments.js";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";

registerNewSessionSetupEnglish();

export type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";

export type ChatRunStartupState =
  | {
      state: "status";
      runId: string;
      phase: ChatRunStartupPhase;
      waitReason?: "response" | "slot";
      seq?: number;
    }
  | { state: "status"; runId: string; phase: "answer" | "finishing"; seq?: number }
  | {
      state: "status";
      runId: string;
      phase: "retrying" | "fallback";
      retryAt?: number;
      seq: number;
    }
  | { state: "activity"; runId: string; seq?: number };

export type ChatRunStartupStatus = Extract<ChatRunStartupState, { state: "status" }>;

export function isChatRunRecoveryStatus(status: ChatRunStartupState | null | undefined): boolean {
  return status?.state === "status" && (status.phase === "retrying" || status.phase === "fallback");
}

/** Live status and history retain the same agent sequence; chat deltas have a separate counter. */
export function reconcileChatRunStartup(
  host: { chatRunId?: string | null; chatRunStartup?: ChatRunStartupState | null },
  next: ChatRunStartupState,
): void {
  if (host.chatRunId !== next.runId) {
    return;
  }
  const current = host.chatRunStartup;
  if (current?.runId === next.runId) {
    const isModelWaitTransition =
      next.state === "status" &&
      (next.phase === "waiting_for_model" ||
        (next.phase === "starting_model" &&
          current.state === "status" &&
          current.phase === "waiting_for_model"));
    // Finishing settles one attempt, not the run. Only newer agent activity can resume it.
    if (
      current.state === "status" &&
      current.phase === "finishing" &&
      (next.seq === undefined || (current.seq !== undefined && next.seq <= current.seq))
    ) {
      return;
    }
    if (
      current.state === "status" &&
      current.phase === "answer" &&
      next.seq === undefined &&
      !(next.state === "status" && next.phase === "finishing")
    ) {
      return;
    }
    if (
      (next.state === "status" &&
        next.phase !== "finishing" &&
        next.phase !== "answer" &&
        !isModelWaitTransition &&
        !isChatRunRecoveryStatus(next) &&
        (current.state === "activity" ||
          (current.state === "status" && current.phase === "answer"))) ||
      (current.state === "status" &&
        current.phase === "starting_model" &&
        next.state === "status" &&
        isChatRunStartupPhase(next.phase) &&
        next.phase !== "starting_model" &&
        next.phase !== "waiting_for_model") ||
      (current.seq !== undefined &&
        (next.seq === undefined
          ? next.state === "status" && next.phase !== "answer" && next.phase !== "finishing"
          : next.seq <= current.seq))
    ) {
      return;
    }
    // Chat deltas use a different sequence; retain the agent sequence so an
    // older reconnect snapshot cannot resurrect an already-cleared retry.
    if (next.seq === undefined && current.seq !== undefined) {
      host.chatRunStartup = { ...next, seq: current.seq };
      return;
    }
  }
  host.chatRunStartup = next;
}

const STARTUP_LABEL_KEYS = {
  waiting_for_state: "chat.startupStatus.waitingForState",
  preparing_workspace: "chat.startupStatus.preparingWorkspace",
  naming_worktree: "chat.startupStatus.namingWorktree",
  creating_worktree: "chat.startupStatus.creatingWorktree",
  running_setup: "chat.startupStatus.runningSetup",
  provisioning_environment: "chat.startupStatus.provisioningEnvironment",
  preparing_context: "chat.startupStatus.preparingContext",
  memory_flushing: "chat.startupStatus.memoryFlushing",
  starting_model: "chat.startupStatus.startingModel",
  waiting_for_model: "chat.startupStatus.waitingForLocalModel",
} as const satisfies Record<ChatRunStartupPhase, Parameters<typeof t>[0]>;

export function isChatRunStartupPhase(value: unknown): value is ChatRunStartupPhase {
  return typeof value === "string" && Object.hasOwn(STARTUP_LABEL_KEYS, value);
}

export function chatStartupStatusLabel(
  run: ChatRunStartupStatus | null | undefined,
  placement: ApplicationPlacementStartupStatus | null | undefined,
  environmentStartStatus: WorkerEnvironmentStartStatus | undefined = placement?.startStatus,
  awaitingActivity = false,
): string | undefined {
  const startStatus = environmentStartStatus;
  if (
    startStatus &&
    placement?.phase !== "reconnecting" &&
    (!run || run.phase === "provisioning_environment")
  ) {
    if (startStatus.phase === "saving") {
      return t("chat.startupStatus.savingSnapshot");
    }
    if (startStatus.mode === "snapshot") {
      return t("chat.startupStatus.startingFromSnapshot");
    }
    if (startStatus.phase === "preparing") {
      return t("chat.startupStatus.preparingCloudEnvironment");
    }
  }
  if (run) {
    if (run.phase === "waiting_for_model" && run.waitReason === "slot") {
      return t("chat.startupStatus.waitingForModelSlot");
    }
    if (run.phase === "finishing" || run.phase === "answer") {
      return undefined;
    }
    if (run.phase === "retrying") {
      return t("chat.recovery.retrying");
    }
    if (run.phase === "fallback") {
      return t("chat.recovery.tryingFallback");
    }
    return t(STARTUP_LABEL_KEYS[run.phase]);
  }
  switch (placement?.phase) {
    case "reconnecting":
      return t("connection.reconnecting");
    case "pending":
    case "requested":
    case "provisioning":
      return t("chat.startupStatus.provisioningEnvironment");
    case "syncing":
      return t("chat.startupStatus.preparingWorkspace");
    case "starting":
      return t("newSession.starting");
    case "active":
    case "sending":
      return t("chat.composer.sendingMessage");
    default:
      // Queue custody and recovery can precede execution; only an explicit phase proves preparation.
      return awaitingActivity ? t("chat.startupStatus.waitingForTurn") : undefined;
  }
}

export function activeChatRunStartupStatus(
  startup: ChatRunStartupState | null | undefined,
): ChatRunStartupStatus | null {
  return startup?.state === "status" ? startup : null;
}
