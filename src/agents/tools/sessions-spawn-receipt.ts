import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  normalizeAcceptedSessionSpawnResult,
} from "../accepted-session-spawn.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { recordSessionToolActionFact } from "./sessions-helpers.js";

export function recordAcceptedSessionSpawn(
  result: Record<string, unknown>,
  context: "fork" | "isolated" | undefined,
): void {
  const instance = getGatewayToolCallerIdentity()?.operationalRunInstance;
  const accepted = normalizeAcceptedSessionSpawnResult({ details: result });
  if (instance && accepted) {
    mergeAcceptedSessionSpawnsForRun(instance, [accepted]);
  }
  const childSessionKey =
    typeof result.childSessionKey === "string" ? result.childSessionKey.trim() : "";
  const targetAgentId = childSessionKey
    ? parseAgentSessionKey(childSessionKey)?.agentId
    : undefined;
  if (result.status !== "accepted" || !childSessionKey || !targetAgentId || !context) {
    return;
  }
  recordSessionToolActionFact({
    operation: context === "fork" ? "fork" : "create",
    fact: "committed",
    targetAgentId,
    targetSessionKey: childSessionKey,
  });
}
