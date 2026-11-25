import {
  ErrorCodes,
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  readMissingScopeError,
} from "@openclaw/gateway-client/browser";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { canPresentGatewayMethod, type GatewayMethodOperatorScope } from "../gateway-methods.ts";
import type { AgentsPanel } from "./panels.ts";

export type AgentSettingsPanelAccess = "pending" | "available" | "denied";

/** Presentation facts only. Request and mutation owners still recheck live authority. */
export function resolveAgentSettingsAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">,
  isSessionAgent: boolean,
) {
  const canRead = (method: string, scope: GatewayMethodOperatorScope = "operator.read") =>
    canPresentGatewayMethod(snapshot, method, scope);
  const reads = {
    config: canRead("config.get"),
    identity: canRead("agent.identity.get"),
    models: canRead("models.list"),
    files: canRead("agents.files.list") && canRead("agents.files.get"),
    catalog: canRead("tools.catalog"),
    effectiveTools: isSessionAgent && canRead("tools.effective"),
    skills: canRead("skills.status"),
    channels: canRead("channels.status"),
    cron: canRead("cron.list") && canRead("cron.status"),
    memory: canRead("doctor.memory.status") || canRead("doctor.memory.dreamDiary"),
  };
  const panel = (available: boolean): AgentSettingsPanelAccess =>
    !snapshot.hello ? "pending" : available ? "available" : "denied";
  const panels: Record<AgentsPanel, AgentSettingsPanelAccess> = {
    overview: panel(canRead("agents.list")),
    files: panel(reads.files),
    tools: panel(reads.catalog || reads.effectiveTools || reads.config),
    skills: panel(reads.skills),
    channels: panel(reads.channels),
    cron: panel(reads.cron),
    memory: panel(reads.memory),
  };
  return { reads, panels };
}

export type AgentSettingsAccess = ReturnType<typeof resolveAgentSettingsAccess>;

/** A denial is terminal for this receipt; only changed access admits a new read. */
export function resolveAgentSettingsReadFailure(error: unknown) {
  const denied =
    Boolean(readMissingScopeError(error)) ||
    (error instanceof GatewayProtocolRequestError && error.gatewayCode === ErrorCodes.FORBIDDEN);
  return {
    state: denied ? ("denied" as const) : ("failed" as const),
    retryable:
      !denied &&
      (error instanceof GatewayProtocolRequestTimeoutError ||
        (error instanceof GatewayProtocolRequestError &&
          error.gatewayCode === ErrorCodes.UNAVAILABLE &&
          error.retryable)),
  };
}
