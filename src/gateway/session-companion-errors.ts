import { assertNoUnmigratedWorkspaceState } from "../agents/workspace-legacy-state.js";
import { findStartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";

type SessionCompanionAskErrorReason =
  | "busy"
  | "context-unavailable"
  | "rate-limited"
  | "timeout"
  | "session-missing"
  | "utility-model-unavailable"
  | "image-input-unsupported"
  | "unavailable";

export class SessionCompanionAskError extends Error {
  constructor(
    readonly reason: SessionCompanionAskErrorReason,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SessionCompanionAskError";
  }
}

export function assertWorkspaceReady(workspaceDir: string): void {
  try {
    assertNoUnmigratedWorkspaceState({ workspaceDir });
  } catch (error) {
    if (findStartupMaintenanceRequiredError(error)?.kind !== "legacy-workspace") {
      throw error;
    }
    throw new SessionCompanionAskError(
      "unavailable",
      "This agent's workspace needs migration. Ask the gateway operator to run `openclaw doctor --fix`.",
    );
  }
}
