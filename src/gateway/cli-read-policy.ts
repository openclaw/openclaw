import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Authorization scopes do not describe side effects (operator.read includes sign-in
// and profile mutations). Unknown methods and node invocations retain receipt custody.
const READ_ONLY_GATEWAY_CLI_METHODS: Readonly<Record<string, true>> = {
  health: true,
  status: true,
  "system-presence": true,
  "system.info": true,
  "usage.cost": true,
  "diagnostics.stability": true,
  "diagnostics.capabilities": true,
  "diagnostics.lanes": true,
  "logs.tail": true,
  "config.get": true,
  "config.schema": true,
  "config.schema.lookup": true,
  "node.list": true,
  "node.describe": true,
  "node.pair.list": true,
  "device.pair.list": true,
  "last-heartbeat": true,
  "tts.status": true,
  "tts.providers": true,
  "tts.personas": true,
  "agents.list": true,
  "agents.files.list": true,
  "agents.files.get": true,
  "users.list": true,
  "toolUsage.status": true,
  "skills.library.list": true,
  "skills.library.read": true,
  "voicewake.get": true,
  "voicewake.routing.get": true,
  "exec.approvals.get": true,
  "exec.approvals.node.get": true,
  "exec.approval.get": true,
  "exec.approval.list": true,
  "exec.approval.grants.list": true,
  "plugin.approval.list": true,
  "openclaw.approval.list": true,
  "approval.get": true,
  "cron.status": true,
  "cron.list": true,
  "cron.get": true,
  "cron.runs": true,
  "cron.scratch.get": true,
};

/** CLI reads inherit cancellation; decision-bearing calls still own their receipt. */
export function isReadOnlyGatewayCliCall(method: string, params?: unknown): boolean {
  if (method === "device.pair.code") {
    return isRecord(params) && params.decision === undefined && params.requestId === undefined;
  }
  return Object.hasOwn(READ_ONLY_GATEWAY_CLI_METHODS, method);
}
